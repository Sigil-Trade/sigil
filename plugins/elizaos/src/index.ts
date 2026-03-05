export { phalnxPlugin } from "./plugin";
export { ENV_KEYS, type PhalnxElizaConfig } from "./types";
export { getOrCreateShieldedWallet, getConfig } from "./client-factory";
export {
  statusAction,
  updatePolicyAction,
  pauseResumeAction,
  transactionHistoryAction,
  provisionAction,
  x402FetchAction,
} from "./actions";
export { shieldStatusProvider, spendTrackingProvider } from "./providers";
export { policyCheckEvaluator } from "./evaluators";

// Default export for ElizaOS plugin loader
import { phalnxPlugin } from "./plugin";
export default phalnxPlugin;
