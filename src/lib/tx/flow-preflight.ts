import { erc20Abi, formatUnits, parseUnits, type PublicClient } from "viem";
import {
  checkMiniPaySpendBuffer,
  minipayEntryForSymbol,
} from "@/lib/minipay/minipay-spend-buffer";
import { resolveMiniPayFeeCurrency } from "@/lib/minipay/minipay-fee-currency";

export type FlowPreflightOptions = {
  supportsFeeAbstraction?: boolean;
};

export type FlowPreflightResult = {
  ok: boolean;
  token?: string;
  amount?: string;
  message?: string;
};

const TOKEN_DECIMALS: Record<string, number> = {
  USDT: 6,
  USDC: 6,
  USDm: 18,
};

/** Parse summaries like "Supply 981.83 USDT to Aave V3 on Celo". */
export function parseSupplySummary(summary: string): {
  amount: string;
  token: string;
} | null {
  const match = summary.match(/^Supply\s+([\d.]+)\s+(\S+)\s+to\s+Aave/i);
  if (!match) {
    return null;
  }

  return { amount: match[1], token: match[2] };
}

function resolveMinipayTokenEntry(token: string):
  | { symbol: string; token: `0x${string}`; decimals: number }
  | undefined {
  const entry = minipayEntryForSymbol(token);
  if (!entry) {
    return undefined;
  }

  return {
    symbol: entry.symbol,
    token: entry.token,
    decimals: TOKEN_DECIMALS[entry.symbol] ?? 18,
  };
}

export async function checkFlowPreflight(
  publicClient: PublicClient,
  address: `0x${string}`,
  summary: string,
  options?: FlowPreflightOptions,
): Promise<FlowPreflightResult> {
  if (options?.supportsFeeAbstraction !== true) {
    return { ok: true };
  }

  const parsed = parseSupplySummary(summary);
  if (!parsed) {
    return { ok: true };
  }

  const entry = resolveMinipayTokenEntry(parsed.token);
  if (!entry) {
    return { ok: true };
  }

  let amountWei: bigint;
  try {
    amountWei = parseUnits(parsed.amount, entry.decimals);
  } catch {
    return {
      ok: false,
      token: parsed.token,
      amount: parsed.amount,
      message: `Invalid amount "${parsed.amount}".`,
    };
  }

  const balance = await publicClient.readContract({
    address: entry.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

  const feeCurrency = await resolveMiniPayFeeCurrency(publicClient, address, {
    isMiniPay: true,
  });

  if (!feeCurrency) {
    return { ok: true, token: parsed.token, amount: parsed.amount };
  }

  const bufferCheck = checkMiniPaySpendBuffer({
    balance,
    spendAmountWei: amountWei,
    feeCurrency,
    spendTokenAddress: entry.token,
  });

  if (!bufferCheck.ok) {
    return {
      ok: false,
      token: parsed.token,
      amount: parsed.amount,
      message: bufferCheck.message,
    };
  }

  if (balance < amountWei) {
    return {
      ok: false,
      token: parsed.token,
      amount: parsed.amount,
      message: `Insufficient ${parsed.token}. You have ${formatUnits(balance, entry.decimals)} but tried to supply ${parsed.amount}.`,
    };
  }

  return {
    ok: true,
    token: parsed.token,
    amount: parsed.amount,
  };
}
