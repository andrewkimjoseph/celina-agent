"use client";

import { useFlowPreflight } from "@/hooks/use-flow-preflight";
import { useTxPreflight } from "@/hooks/use-tx-preflight";
import { useWalletBalances } from "@/hooks/use-wallet-balances";
import { useWalletCapabilities } from "@/hooks/use-wallet-capabilities";
import { parseSupplySummary } from "@/lib/tx/flow-preflight";
import type { PreparedTx } from "@/lib/tx/prepared-flow";
import { simulatePreparedStepBeforeSend } from "@/lib/tx/prepared-step-simulation";
import { formatRevertedStepError } from "@/lib/tx/revert-error";
import { parseSendSummary } from "@/lib/tx/send-preflight";
import {
  categorizeSimulationError,
  formatSimulationError,
  type SimulationErrorDisplay,
} from "@/lib/tx/simulation-error";
import { formatFlowSummary, formatWalletError } from "@/lib/tx/wallet-error";
import { formatTransactionStep } from "@/lib/tx/transaction-display";
import { useState } from "react";
import { reportCelinaOnchainTxn } from "@andrewkimjoseph/celina-sdk/onchain-stats";
import { useAccount, usePublicClient, useSendTransaction } from "wagmi";
import { trackEvent } from "@/lib/analytics/amplitude-browser";
import { categorizeWalletError } from "@/lib/analytics/events";
import { inferFlowCategory } from "@/lib/analytics/flow-category";
import { formatTxHash } from "@/lib/wallet/format-balance";
import { celoscanTxUrl } from "@/lib/wallet/links";
import {
  formatMessageTimestamp,
  MESSAGE_TIMESTAMP_CLASS,
} from "@/lib/chat/chat-message-metadata";

type CardStatus = "idle" | "signing" | "done" | "error";

interface TxConfirmCardProps {
  summary: string;
  steps: PreparedTx[];
  recipientLabel?: string;
  warnings?: string[];
  deepLink?: string;
  confirmedAt?: number;
  initialCompleted?: boolean;
  initialCompletedHashes?: string[];
  onComplete: (hashes: string[]) => void;
  onDismiss: () => void;
}

const CARD_COPY: Record<
  CardStatus,
  { title: string; hint: string; icon: "ready" | "wallet" | "cancelled" }
> = {
  idle: {
    title: "Ready to confirm",
    hint: "Tap Confirm below — your wallet will open to approve.",
    icon: "ready",
  },
  signing: {
    title: "Waiting for wallet",
    hint: "Approve or reject the transaction in your wallet app.",
    icon: "wallet",
  },
  done: {
    title: "Transaction confirmed",
    hint: "Saved to your history. Tap a hash to view details.",
    icon: "ready",
  },
  error: {
    title: "Not sent",
    hint: "Nothing was submitted on-chain.",
    icon: "cancelled",
  },
};

function CardIcon({ variant }: { variant: "ready" | "wallet" | "cancelled" }) {
  if (variant === "cancelled") {
    return (
      <svg
        className="size-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
        />
      </svg>
    );
  }

  if (variant === "wallet") {
    return (
      <svg
        className="size-5 animate-pulse"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9"
        />
      </svg>
    );
  }

  return (
    <svg
      className="size-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

export function TxConfirmCard({
  summary,
  steps,
  recipientLabel,
  warnings,
  deepLink,
  confirmedAt: confirmedAtProp,
  initialCompleted = false,
  initialCompletedHashes = [],
  onComplete,
  onDismiss,
}: TxConfirmCardProps) {
  const [status, setStatus] = useState<CardStatus>(
    initialCompleted ? "done" : "idle",
  );
  const [signingStepIndex, setSigningStepIndex] = useState(0);
  const [completedHashes, setCompletedHashes] = useState<string[]>(
    initialCompletedHashes,
  );
  const [confirmedAt, setConfirmedAt] = useState<number | undefined>(
    confirmedAtProp,
  );
  const [revertedOnChain, setRevertedOnChain] = useState(false);
  const [errorDisplay, setErrorDisplay] = useState<SimulationErrorDisplay | null>(
    null,
  );
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const { address } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const publicClient = usePublicClient();
  const preflight = useTxPreflight(address, summary);
  const flowPreflight = useFlowPreflight(address, summary);
  const { data: walletBalances } = useWalletBalances(address);
  const { supportsFeeAbstraction } = useWalletCapabilities();
  const isSendFlow = parseSendSummary(summary) !== null;
  const isSupplyFlow = parseSupplySummary(summary) !== null;
  const celoBalance = Number(walletBalances?.celo?.formatted ?? 0);
  const insufficientGas =
    !supportsFeeAbstraction && !isSendFlow && celoBalance <= 0;
  const flowCategory = inferFlowCategory(summary);
  const preflightBlocked =
    isSendFlow &&
    preflight.status === "ready" &&
    !preflight.data.ok;
  const flowPreflightBlocked =
    isSupplyFlow &&
    flowPreflight.status === "ready" &&
    !flowPreflight.data.ok;
  const celoSendBlocked =
    preflightBlocked &&
    preflight.status === "ready" &&
    preflight.data.blocksCeloSend === true;
  const blockedRecipientSend =
    preflightBlocked &&
    preflight.status === "ready" &&
    preflight.data.blockedRecipient === true;

  const copy = CARD_COPY[status];
  const displaySummary = formatFlowSummary(summary, recipientLabel);
  const isBusy = status === "signing" || status === "done";
  const preflightLoading =
    (isSendFlow && preflight.status === "loading") ||
    (isSupplyFlow && flowPreflight.status === "loading");
  const confirmDisabled =
    isBusy ||
    preflightBlocked ||
    flowPreflightBlocked ||
    insufficientGas ||
    preflightLoading;

  const partialMultiStepError =
    status === "error" &&
    completedHashes.length > 0 &&
    steps.length > 1;

  const cardTitle =
    insufficientGas
      ? "Insufficient CELO for gas"
      : celoSendBlocked
        ? "CELO sends not supported"
        : blockedRecipientSend
          ? "Cannot send here"
          : preflightBlocked && preflight.status === "ready"
            ? "Insufficient balance"
            : flowPreflightBlocked && flowPreflight.status === "ready"
              ? "Insufficient balance"
              : partialMultiStepError
                ? "Step incomplete"
                : status === "error" && errorDisplay
                  ? errorDisplay.title
                  : copy.title;

  const cardHint =
    status === "signing" && steps.length > 1
      ? `Step ${signingStepIndex + 1} of ${steps.length} — approve in your wallet.`
      : partialMultiStepError
        ? `Step ${completedHashes.length} of ${steps.length} is done. The next step didn't go through yet.`
        : status === "error" && revertedOnChain && completedHashes.length === 0
          ? "This didn't complete. You may still have paid network fees."
          : copy.hint;

  const confirmLabel =
    status === "signing"
      ? "Waiting for wallet…"
      : status === "error" && errorDisplay?.retryable
        ? "Try again"
        : "Confirm";

  const iconStyles =
    status === "done"
      ? "rounded-[2px] border-2 border-[var(--ink)] bg-[var(--success)] text-[var(--ink)]"
      : status === "error"
        ? "rounded-[2px] border-2 border-[var(--ink)] bg-[var(--warn)] text-white"
        : "rounded-[2px] border-2 border-[var(--ink)] bg-[var(--accent)] text-[var(--accent-foreground)]";

  function handleDismiss() {
    setCompletedHashes([]);
    setRevertedOnChain(false);
    setErrorDisplay(null);
    setStatus("idle");
    onDismiss();
  }

  async function handleConfirm() {
    if (!publicClient || !address) {
      setErrorDisplay({
        title: "Wallet unavailable",
        message: "Reconnect your wallet, then tap Confirm below.",
        retryable: true,
      });
      setStatus("error");
      return;
    }

    setStatus("signing");
    setRevertedOnChain(false);
    setErrorDisplay(null);
    setShowTechnicalDetails(false);
    trackEvent("tx_confirm_clicked", {
      step_count: steps.length,
      flow_category: flowCategory,
    });

    const startIndex = completedHashes.length;
    setSigningStepIndex(startIndex);
    const sessionHashes = [...completedHashes];
    let feeCurrency: `0x${string}` | undefined;

    try {
      for (let index = startIndex; index < steps.length; index++) {
        setSigningStepIndex(index);
        const step = steps[index]!;

        const simulation = await simulatePreparedStepBeforeSend(
          publicClient,
          address,
          step,
          {
            supportsFeeAbstraction,
            feeCurrency,
          },
        );
        if (!simulation.ok) {
          const friendly = formatSimulationError(simulation.rawMessage, {
            stepIndex: index,
            stepCount: steps.length,
            completedStepCount: sessionHashes.length,
          });
          setStatus("error");
          setErrorDisplay(friendly);
          trackEvent("tx_failed", {
            flow_category: flowCategory,
            error_category: categorizeSimulationError(
              friendly.title,
              friendly.retryable,
            ),
            simulation_retryable: friendly.retryable,
          });
          return;
        }
        feeCurrency = simulation.feeCurrency ?? feeCurrency;

        const hash = await sendTransactionAsync({
          to: step.to,
          data: step.data,
          value: step.value ? BigInt(step.value) : undefined,
          ...(feeCurrency
            ? ({ feeCurrency } as Record<string, `0x${string}`>)
            : {}),
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          setRevertedOnChain(true);
          const revertedError = formatRevertedStepError(step, hash);
          setStatus("error");
          setErrorDisplay(revertedError);
          trackEvent("tx_failed", {
            flow_category: flowCategory,
            error_category: categorizeWalletError(revertedError.title),
          });
          return;
        }

        reportCelinaOnchainTxn(hash);
        sessionHashes.push(hash);
        setCompletedHashes([...sessionHashes]);
      }

      setStatus("done");
      const nextConfirmedAt = Date.now();
      setConfirmedAt(nextConfirmedAt);
      trackEvent("tx_confirmed", {
        step_count: steps.length,
        hash_count: sessionHashes.length,
        flow_category: flowCategory,
      });
      onComplete(sessionHashes);
    } catch (err) {
      setStatus("error");
      const walletError = formatWalletError(err);
      setErrorDisplay(walletError);
      trackEvent("tx_failed", {
        flow_category: flowCategory,
        error_category: categorizeWalletError(walletError.title),
      });
    }
  }

  const displayConfirmedAt = confirmedAtProp ?? confirmedAt;
  const timestampLabel =
    status === "done" && displayConfirmedAt != null
      ? formatMessageTimestamp(displayConfirmedAt)
      : null;

  return (
    <div className="card-brutal w-full min-w-0 max-w-full p-4">
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex size-9 shrink-0 items-center justify-center ${iconStyles}`}
          aria-hidden
        >
          <CardIcon variant={copy.icon} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className="text-sm font-bold text-[var(--ink)]"
            >
              {cardTitle}
            </p>
            {timestampLabel ? (
              <time
                dateTime={new Date(displayConfirmedAt!).toISOString()}
                className={MESSAGE_TIMESTAMP_CLASS}
              >
                {timestampLabel}
              </time>
            ) : null}
          </div>
          <p className="mt-1 break-words text-sm leading-relaxed text-[var(--text-secondary)]">
            {displaySummary}
          </p>
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">{cardHint}</p>
        </div>
      </div>

      {warnings && warnings.length > 0 && (
        <div
          className="mt-3 rounded-[2px] border-2 border-[var(--ink)] bg-[var(--warn)] px-3 py-2.5"
          role="status"
        >
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-white">Warnings</p>
          <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-white">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {deepLink && (
        <p className="mt-3">
          <a
            href={deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-bold text-[var(--ink)] underline underline-offset-2"
          >
            View details
          </a>
        </p>
      )}

      {(isSendFlow || isSupplyFlow) &&
        (preflightLoading || preflightBlocked || flowPreflightBlocked) && (
          <div className="mt-3 border-t-2 border-[var(--ink)] pt-3">
            {preflightLoading && (
              <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <span
                  className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-[var(--ink)] border-t-[var(--accent)]"
                  aria-hidden
                />
                Checking your balance…
              </p>
            )}
            {preflightBlocked && preflight.status === "ready" && (
              <p className="break-words text-xs font-bold text-[var(--warn)]" role="alert">
                {preflight.data.message}
              </p>
            )}
            {flowPreflightBlocked && flowPreflight.status === "ready" && (
              <p className="break-words text-xs font-bold text-[var(--warn)]" role="alert">
                {flowPreflight.data.message}
              </p>
            )}
          </div>
        )}

      {!isSendFlow && insufficientGas && (
        <div className="mt-3 border-t-2 border-[var(--ink)] pt-3">
          <p className="text-xs font-bold text-[var(--warn)]" role="alert">
            You need a small CELO balance to pay network fees. Add CELO to your
            wallet, then try again.
          </p>
        </div>
      )}

      <ol className="mt-3 space-y-1.5 border-t-2 border-[var(--ink)] pt-3">
        {steps.map((step, index) => (
          <li
            key={`${step.description}-${index}`}
            className="flex gap-2 text-sm text-[var(--text-secondary)]"
          >
            <span className="font-bold text-[var(--ink)]">{index + 1}.</span>
            <span className="min-w-0 break-words">
              {formatTransactionStep(step.description, { summary })}
            </span>
          </li>
        ))}
      </ol>

      {status === "done" && completedHashes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t-2 border-[var(--ink)] pt-3">
          {completedHashes.map((hash) => (
            <a
              key={hash}
              href={celoscanTxUrl(hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-[2px] border-2 border-[var(--ink)] bg-[var(--success)] px-2.5 py-1 font-mono text-xs font-bold text-[var(--ink)]"
              title={hash}
            >
              {formatTxHash(hash)}
            </a>
          ))}
        </div>
      )}

      {errorDisplay && (
        <div
          className="mt-3 rounded-[2px] border-2 border-[var(--ink)] bg-[var(--warn)] px-3 py-2.5"
          role="alert"
        >
          <p className="break-words text-sm font-semibold text-white">
            {errorDisplay.title}
          </p>
          <p className="mt-0.5 break-words text-sm text-white">
            {errorDisplay.message}
          </p>
          {errorDisplay.technicalDetails && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowTechnicalDetails((open) => !open)}
                className="text-xs font-semibold text-white underline underline-offset-2"
              >
                {showTechnicalDetails ? "Hide details" : "Show technical details"}
              </button>
              {showTechnicalDetails && (
                <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all border-2 border-[var(--ink)] bg-[var(--canvas)] p-2 text-[10px] leading-snug text-[var(--text-secondary)]">
                  {errorDisplay.technicalDetails}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {status !== "done" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => void handleConfirm()}
            className="btn-brutal btn-primary px-4 py-2 text-sm disabled:opacity-50"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            disabled={status === "signing"}
            onClick={handleDismiss}
            className="btn-brutal btn-secondary px-4 py-2 text-sm disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
