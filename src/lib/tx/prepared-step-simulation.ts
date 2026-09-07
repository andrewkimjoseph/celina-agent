import { simulatePreparedStepWithRetry } from "@andrewkimjoseph/celina-sdk/simulation";
import { erc20Abi, parseUnits, type PublicClient } from "viem";
import type { PreparedTx } from "@/lib/tx/prepared-flow";
import { parseSupplyStepDescription } from "@/lib/tx/flow-preflight";
import { resolveMiniPayFeeCurrency } from "@/lib/minipay/minipay-fee-currency";
import {
  checkMiniPaySpendBuffer,
  minipayEntryForSymbol,
} from "@/lib/minipay/minipay-spend-buffer";
import { formatWalletError } from "@/lib/tx/wallet-error";

export type PreparedStepSimulationOptions = {
  supportsFeeAbstraction?: boolean;
  feeCurrency?: `0x${string}`;
};

export type PreparedStepSimulationFailure = {
  ok: false;
  rawMessage: string;
};

export type PreparedStepSimulationSuccess = {
  ok: true;
  feeCurrency?: `0x${string}`;
};

const TOKEN_DECIMALS: Record<string, number> = {
  USDT: 6,
  USDC: 6,
  USDm: 18,
};

async function checkStepMiniPaySpendBuffer(
  publicClient: PublicClient,
  from: `0x${string}`,
  step: PreparedTx,
  feeCurrency: `0x${string}`,
): Promise<PreparedStepSimulationFailure | null> {
  const supply = parseSupplyStepDescription(step.description);
  if (!supply) {
    return null;
  }

  const entry = minipayEntryForSymbol(supply.token);
  if (!entry) {
    return null;
  }

  let spendAmountWei: bigint;
  try {
    spendAmountWei = parseUnits(
      supply.amount,
      TOKEN_DECIMALS[entry.symbol] ?? 18,
    );
  } catch {
    return null;
  }

  const balance = await publicClient.readContract({
    address: entry.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  });

  const bufferCheck = checkMiniPaySpendBuffer({
    balance,
    spendAmountWei,
    feeCurrency,
    spendTokenAddress: entry.token,
  });

  if (!bufferCheck.ok) {
    return {
      ok: false,
      rawMessage: `Simulation failed for "${step.description}": ${bufferCheck.message ?? "insufficient balance after network fees."}`,
    };
  }

  return null;
}

/**
 * Simulate one prepared step immediately before wallet broadcast.
 * Resolves MiniPay feeCurrency in Celeste; SDK stays wallet-product agnostic.
 */
export async function simulatePreparedStepBeforeSend(
  publicClient: PublicClient,
  from: `0x${string}`,
  step: PreparedTx,
  options?: PreparedStepSimulationOptions,
): Promise<PreparedStepSimulationSuccess | PreparedStepSimulationFailure> {
  let feeCurrency = options?.feeCurrency;

  if (options?.supportsFeeAbstraction && !feeCurrency) {
    try {
      feeCurrency = await resolveMiniPayFeeCurrency(publicClient, from, {
        isMiniPay: true,
      });
    } catch (error) {
      const formatted = formatWalletError(error);
      return {
        ok: false,
        rawMessage: formatted.technicalDetails ?? formatted.message,
      };
    }
  }

  if (options?.supportsFeeAbstraction && feeCurrency) {
    const bufferFailure = await checkStepMiniPaySpendBuffer(
      publicClient,
      from,
      step,
      feeCurrency,
    );
    if (bufferFailure) {
      return bufferFailure;
    }
  }

  try {
    await simulatePreparedStepWithRetry(
      publicClient as never,
      { account: from, step },
      feeCurrency ? { feeCurrency } : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      rawMessage: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, feeCurrency };
}
