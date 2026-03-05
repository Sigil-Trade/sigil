export { checkVaultTool, checkVault, checkVaultSchema } from "./check-vault";
export {
  checkSpendingTool,
  checkSpending,
  checkSpendingSchema,
} from "./check-spending";
export {
  createVaultTool,
  createVault,
  createVaultSchema,
} from "./create-vault";
export { depositTool, deposit, depositSchema } from "./deposit";
export { withdrawTool, withdraw, withdrawSchema } from "./withdraw";
export {
  registerAgentTool,
  registerAgent,
  registerAgentSchema,
} from "./register-agent";
export {
  updatePolicyTool,
  updatePolicy,
  updatePolicySchema,
} from "./update-policy";
export {
  revokeAgentTool,
  revokeAgent,
  revokeAgentSchema,
} from "./revoke-agent";
export {
  reactivateVaultTool,
  reactivateVault,
  reactivateVaultSchema,
} from "./reactivate-vault";
export {
  executeSwapTool,
  executeSwap,
  executeSwapSchema,
} from "./execute-swap";
export {
  openPositionTool,
  openPosition,
  openPositionSchema,
} from "./open-position";
export {
  closePositionTool,
  closePosition,
  closePositionSchema,
} from "./close-position";
export { provisionTool, provision, provisionSchema } from "./provision";
export {
  queuePolicyUpdateTool,
  queuePolicyUpdate,
  queuePolicyUpdateSchema,
} from "./queue-policy-update";
export {
  applyPendingPolicyTool,
  applyPendingPolicy,
  applyPendingPolicySchema,
} from "./apply-pending-policy";
export {
  cancelPendingPolicyTool,
  cancelPendingPolicy,
  cancelPendingPolicySchema,
} from "./cancel-pending-policy";
export {
  checkPendingPolicyTool,
  checkPendingPolicy,
  checkPendingPolicySchema,
} from "./check-pending-policy";
export {
  agentTransferTool,
  agentTransfer,
  agentTransferSchema,
} from "./agent-transfer";
export {
  setupStatusTool,
  setupStatus,
  setupStatusSchema,
} from "./setup-status";
export { configureTool, configure, configureSchema } from "./configure";
export { fundWalletTool, fundWallet, fundWalletSchema } from "./fund-wallet";
export {
  configureFromFileTool,
  configureFromFile,
  configureFromFileSchema,
} from "./configure-from-file";
export { x402FetchTool, x402Fetch, x402FetchSchema } from "./x402-fetch";
export {
  addCollateralTool,
  addCollateral,
  addCollateralSchema,
} from "./add-collateral";
export {
  removeCollateralTool,
  removeCollateral,
  removeCollateralSchema,
} from "./remove-collateral";
export {
  placeTriggerOrderTool,
  placeTriggerOrder,
  placeTriggerOrderSchema,
} from "./place-trigger-order";
export {
  cancelTriggerOrderTool,
  cancelTriggerOrder,
  cancelTriggerOrderSchema,
} from "./cancel-trigger-order";
export {
  placeLimitOrderTool,
  placeLimitOrder,
  placeLimitOrderSchema,
} from "./place-limit-order";
export {
  cancelLimitOrderTool,
  cancelLimitOrder,
  cancelLimitOrderSchema,
} from "./cancel-limit-order";
export {
  syncPositionsTool,
  syncPositions,
  syncPositionsSchema,
} from "./sync-positions";

// --- Multi-Agent Permissions ---
export {
  updateAgentPermissionsTool,
  updateAgentPermissions,
  updateAgentPermissionsSchema,
} from "./update-agent-permissions";

// --- Jupiter Expanded Integration ---
export { getPricesTool, getPrices, getPricesSchema } from "./get-prices";
export {
  searchTokensTool,
  searchTokens,
  searchTokensSchema,
} from "./search-tokens";
export {
  trendingTokensTool,
  trendingTokens,
  trendingTokensSchema,
} from "./trending-tokens";
export { lendTokensTool, lendTokens, lendTokensSchema } from "./lend-tokens";
export {
  lendDepositTool,
  lendDeposit,
  lendDepositSchema,
} from "./lend-deposit";
export {
  lendWithdrawTool,
  lendWithdraw,
  lendWithdrawSchema,
} from "./lend-withdraw";
export {
  createTriggerOrderJupTool,
  createTriggerOrderJup,
  createTriggerOrderJupSchema,
} from "./create-trigger-order-jup";
export {
  getTriggerOrdersJupTool,
  getTriggerOrdersJup,
  getTriggerOrdersJupSchema,
} from "./get-trigger-orders-jup";
export {
  cancelTriggerOrderJupTool,
  cancelTriggerOrderJup,
  cancelTriggerOrderJupSchema,
} from "./cancel-trigger-order-jup";
export {
  createRecurringOrderTool,
  createRecurringOrder,
  createRecurringOrderSchema,
} from "./create-recurring-order";
export {
  getRecurringOrdersTool,
  getRecurringOrders,
  getRecurringOrdersSchema,
} from "./get-recurring-orders";
export {
  cancelRecurringOrderTool,
  cancelRecurringOrder,
  cancelRecurringOrderSchema,
} from "./cancel-recurring-order";
export {
  jupiterPortfolioTool,
  jupiterPortfolio,
  jupiterPortfolioSchema,
} from "./jupiter-portfolio";

// --- Escrow Operations ---
export {
  createEscrowTool,
  createEscrow,
  createEscrowSchema,
} from "./create-escrow";
export {
  settleEscrowTool,
  settleEscrow,
  settleEscrowSchema,
} from "./settle-escrow";
export {
  refundEscrowTool,
  refundEscrow,
  refundEscrowSchema,
} from "./refund-escrow";
export {
  closeSettledEscrowTool,
  closeSettledEscrow,
  closeSettledEscrowSchema,
} from "./close-settled-escrow";
export {
  checkEscrowTool,
  checkEscrow,
  checkEscrowSchema,
} from "./check-escrow";

// --- Instruction Constraints ---
export {
  createConstraintsTool,
  createConstraints,
  createConstraintsSchema,
} from "./create-constraints";
export {
  updateConstraintsTool,
  updateConstraints,
  updateConstraintsSchema,
} from "./update-constraints";
export {
  closeConstraintsTool,
  closeConstraints,
  closeConstraintsSchema,
} from "./close-constraints";
export {
  queueConstraintsUpdateTool,
  queueConstraintsUpdate as queueConstraintsUpdateHandler,
  queueConstraintsUpdateSchema,
} from "./queue-constraints-update";
export {
  applyConstraintsUpdateTool,
  applyConstraintsUpdate as applyConstraintsUpdateHandler,
  applyConstraintsUpdateSchema,
} from "./apply-constraints-update";
export {
  cancelConstraintsUpdateTool,
  cancelConstraintsUpdate as cancelConstraintsUpdateHandler,
  cancelConstraintsUpdateSchema,
} from "./cancel-constraints-update";
export {
  checkConstraintsTool,
  checkConstraints,
  checkConstraintsSchema,
} from "./check-constraints";

// --- Squads V4 Multisig Governance ---
export {
  squadsCreateMultisigTool,
  squadsCreateMultisig,
  squadsCreateMultisigSchema,
} from "./squads-create-multisig";
export {
  squadsProposeActionTool,
  squadsProposeAction,
  squadsProposeActionSchema,
} from "./squads-propose-action";
export {
  squadsApproveTool,
  squadsApprove,
  squadsApproveSchema,
} from "./squads-approve";
export {
  squadsRejectTool,
  squadsReject,
  squadsRejectSchema,
} from "./squads-reject";
export {
  squadsExecuteTool,
  squadsExecute,
  squadsExecuteSchema,
} from "./squads-execute";
export {
  squadsStatusTool,
  squadsStatus,
  squadsStatusSchema,
} from "./squads-status";

// --- Vault Discovery & Confirmation ---
export {
  discoverVaultTool,
  discoverVault,
  discoverVaultSchema,
} from "./discover-vault";
export {
  confirmVaultTool,
  confirmVault,
  confirmVaultSchema,
} from "./confirm-vault";
