import { z } from "zod";
import type { ResolvedConfig } from "../types";

export const pauseResumeSchema = z.object({
  action: z
    .enum(["pause", "resume"])
    .describe("Whether to pause or resume Phalnx enforcement."),
});

export type PauseResumeInput = z.infer<typeof pauseResumeSchema>;

export async function pauseResume(
  _agent: any,
  config: ResolvedConfig,
  input: PauseResumeInput,
): Promise<string> {
  if (input.action === "pause") {
    config.wallet.pause();
    return "Phalnx enforcement paused. Transactions will pass through without policy checks.";
  } else {
    config.wallet.resume();
    return "Phalnx enforcement resumed. Policy checks are active.";
  }
}
