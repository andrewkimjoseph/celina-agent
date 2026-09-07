import type { WalletErrorDisplay } from "@/lib/tx/wallet-error";

export type SimulationErrorContext = {
  stepIndex: number;
  stepCount: number;
  completedStepCount: number;
};

export type SimulationErrorDisplay = WalletErrorDisplay & {
  retryable?: boolean;
};

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

/** Map SDK/viem simulation failures to friendly, retry-aware copy for the confirm card. */
export function formatSimulationError(
  error: unknown,
  context?: SimulationErrorContext,
): SimulationErrorDisplay {
  const raw = rawMessage(error);
  const lower = raw.toLowerCase();
  const completedStepCount = context?.completedStepCount ?? 0;

  if (
    lower.includes("insufficient balance") ||
    lower.includes("exceeds balance") ||
    lower.includes("network fees")
  ) {
    const supplyMatch = raw.match(/Supply\s+[\d.]+\s+(\S+)/i);
    const token = supplyMatch?.[1];

    return {
      title: "Insufficient balance",
      message: token
        ? `You're supplying almost all your ${token}. Leave a little for network fees, or try a slightly smaller amount.`
        : "Your wallet doesn't have enough for this transaction. Try a smaller amount.",
      technicalDetails: raw,
      retryable: false,
    };
  }

  if (completedStepCount > 0) {
    return {
      title: "Almost there",
      message:
        "Your approval went through, but the network preview hasn't caught up yet. Wait a few seconds, then tap Try again.",
      technicalDetails: raw,
      retryable: true,
    };
  }

  if (
    lower.includes("exceeds allowance") ||
    lower.includes("transfer amount exceeds allowance")
  ) {
    return {
      title: "Approval needed",
      message:
        "This flow needs a token approval first. Tap Confirm to continue.",
      technicalDetails: raw,
      retryable: true,
    };
  }

  if (lower.includes("simulation failed")) {
    return {
      title: "Couldn't verify yet",
      message:
        "We couldn't preview this step on the network. Wait a moment and tap Try again.",
      technicalDetails: raw,
      retryable: true,
    };
  }

  return {
    title: "Couldn't send",
    message:
      "Something blocked this transaction. Tap Try again or Dismiss to cancel.",
    technicalDetails: raw,
    retryable: true,
  };
}

export function categorizeSimulationError(title: string, retryable?: boolean): string {
  if (retryable) {
    return "simulation_retryable";
  }

  return categorizeSimulationErrorTitle(title);
}

function categorizeSimulationErrorTitle(title: string): string {
  const lower = title.toLowerCase();

  if (lower.includes("insufficient balance")) {
    return "insufficient_balance";
  }

  return "simulation_failed";
}
