import { describe, expect, it } from "vitest";
import { parseUnits, type PublicClient } from "viem";
import {
  parseSpendStepDescription,
  simulatePreparedStepBeforeSend,
} from "@/lib/tx/prepared-step-simulation";
import type { PreparedTx } from "@/lib/tx/prepared-flow";

const USDM_TOKEN = "0x765de816845861e75a25fca122bb6898b8b1282a" as const;

function mockPublicClientWithBalance(balance: bigint): PublicClient {
  return {
    readContract: async () => balance,
  } as unknown as PublicClient;
}

describe("parseSpendStepDescription", () => {
  it("parses Mento FX swap step descriptions (the regression case)", () => {
    expect(
      parseSpendStepDescription("Swap 1.0029 USDm → ~1.003 USDT"),
    ).toEqual({ amount: "1.0029", token: "USDm" });
  });

  it("parses Uniswap v4 swap step descriptions", () => {
    expect(
      parseSpendStepDescription(
        "Swap 5 CELO → ~0.39 USDC via Uniswap v4",
      ),
    ).toEqual({ amount: "5", token: "CELO" });
  });

  it("parses GoodDollar reserve swap step descriptions", () => {
    expect(
      parseSpendStepDescription(
        "Swap 100 GoodDollar → ~0.05 USDm via GoodDollar reserve",
      ),
    ).toEqual({ amount: "100", token: "GoodDollar" });
  });

  it("parses Send step descriptions", () => {
    expect(parseSpendStepDescription("Send 5 CELO")).toEqual({
      amount: "5",
      token: "CELO",
    });
  });

  it("parses Transfer step descriptions", () => {
    expect(parseSpendStepDescription("Transfer 10 USDC")).toEqual({
      amount: "10",
      token: "USDC",
    });
  });

  it("still parses Supply step descriptions", () => {
    expect(
      parseSpendStepDescription("Supply 981.83 USDT to Aave V3"),
    ).toEqual({ amount: "981.83", token: "USDT" });
  });

  it("ignores Approve/Permit2 steps (not a wallet spend of their own token)", () => {
    expect(
      parseSpendStepDescription("Approve USDm for Mento FX"),
    ).toBeNull();
    expect(
      parseSpendStepDescription(
        "Permit2 approve USDC for Uniswap Universal Router",
      ),
    ).toBeNull();
  });

  it("ignores Withdraw steps (funds flow into the wallet, not out)", () => {
    expect(
      parseSpendStepDescription("Withdraw 10 USDT from Aave"),
    ).toBeNull();
  });
});

describe("simulatePreparedStepBeforeSend — MiniPay spend buffer for Mento FX swaps", () => {
  const swapStep: PreparedTx = {
    kind: "contract",
    to: "0x4861840C2Efb2b98312B0aE34d86fD73E8f9B6f6",
    data: "0x",
    value: "0",
    description: "Swap 1.0029 USDm → ~1.003 USDT",
  };

  it("blocks a near-max USDm swap when gas is also paid in USDm (the reported bug)", async () => {
    // Wallet holds only marginally more USDm than the swap amount — not enough
    // extra to also cover the same-token gas reservation.
    const swapAmountWei = parseUnits("1.0029", 18);
    const balance = swapAmountWei + parseUnits("0.003", 18);
    const publicClient = mockPublicClientWithBalance(balance);

    const result = await simulatePreparedStepBeforeSend(
      publicClient,
      "0xa3872860ee9feab369c1a5e911cecc2f4c40f702",
      swapStep,
      { supportsFeeAbstraction: true, feeCurrency: USDM_TOKEN },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawMessage).toContain("Leave a little for network fees");
    }
  });

  it("allows the swap once enough USDm headroom is left for gas", async () => {
    const swapAmountWei = parseUnits("1.0029", 18);
    const balance = swapAmountWei + parseUnits("0.05", 18) + parseUnits("0.01", 18);
    const publicClient = {
      readContract: async () => balance,
      estimateGas: async () => BigInt(21000),
    } as unknown as PublicClient;

    const result = await simulatePreparedStepBeforeSend(
      publicClient,
      "0xa3872860ee9feab369c1a5e911cecc2f4c40f702",
      swapStep,
      { supportsFeeAbstraction: true, feeCurrency: USDM_TOKEN },
    );

    expect(result.ok).toBe(true);
  });

  it("does not block when gas is paid from a different token than the swap input", async () => {
    const swapAmountWei = parseUnits("1.0029", 18);
    const publicClient = {
      readContract: async () => swapAmountWei, // exact balance, no headroom
      estimateGas: async () => BigInt(21000),
    } as unknown as PublicClient;

    // Gas paid in USDT while swapping USDm — buffer only applies when
    // feeCurrency matches the spend token, so this should pass through.
    const result = await simulatePreparedStepBeforeSend(
      publicClient,
      "0xa3872860ee9feab369c1a5e911cecc2f4c40f702",
      swapStep,
      {
        supportsFeeAbstraction: true,
        feeCurrency: "0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72",
      },
    );

    expect(result.ok).toBe(true);
  });
});
