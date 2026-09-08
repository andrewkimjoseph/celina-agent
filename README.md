# Celeste AI

DeFAI chat UI for Celo — applied Celina, a third-party, open-source stack that gives an LLM read, prepare, and execute access to Celo mainnet through an SDK, an MCP server, and a REST API. Connect a wallet, ask about balances, and prepare sends, swaps (Mento FX + GoodDollar reserve + Uniswap v4), and Aave actions — you sign in your wallet.

**Live:** [celeste.usecelina.xyz](https://celeste.usecelina.xyz)

## 8004 submission

- Submission worksheet: [`8004.md`](8004.md)
- Public EIP-8004 manifest: [`public/agent.json`](public/agent.json)
- Expected production manifest URL: [https://celeste.usecelina.xyz/agent.json](https://celeste.usecelina.xyz/agent.json)

**Celeste is independent of Celina MCP.** It does not run `@andrewkimjoseph/celina-mcp`, does not use `CELO_PRIVATE_KEY` or `get_wallet_address`, and is not the same product as [usecelina.xyz](https://usecelina.xyz). It is a Next.js app that calls **`@andrewkimjoseph/celina-sdk`** with the connected wallet address from wagmi (same pattern as any custom SDK + wagmi frontend).

## Setup

```bash
cp .env.example .env.local
# Set OPENROUTER_API_KEY (or OPENAI_API_KEY) and optionally NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
npm install
npm run dev
```

Installs `@andrewkimjoseph/celina-sdk` from npm at the exact version in [`package.json`](package.json) (not a monorepo file link — required for Vercel deploys).

## Stack

- Next.js + Vercel AI SDK + OpenAI-compatible LLM (`/api/chat`) — OpenRouter or direct OpenAI
- wagmi + RainbowKit (Celo mainnet)
- `@andrewkimjoseph/celina-sdk` for chain reads and `prepare*` flows

Prepared transactions include **dual on-chain attribution** via SDK config in [`src/lib/wallet/celina.ts`](src/lib/wallet/celina.ts): legacy `CELINA|…` UTF-8 suffix plus ERC-8021 `toDataSuffix` codes (Celo leaderboards / `verifyTx`). Prefer the `check_attribution_tag` chat tool to list or confirm custom tags on a tx hash after signing (`verify_attribution_tag` for raw layer decode).

No `CELO_PRIVATE_KEY` — writes require wallet confirmation via `TxConfirmCard`.

## Swap routing

Swaps use **composite routing** in [`src/lib/tx/swap-routing.ts`](src/lib/tx/swap-routing.ts): the agent quotes Mento FX, GoodDollar reserve (G$ ↔ USDm), and Uniswap v4 in parallel and picks the better `expectedOut`.

| Tool | Purpose |
|------|---------|
| `get_swap_quote` | **Default for swaps** — Mento + reserve + Uniswap quotes, best route selected |
| `prepare_swap` | Unsigned steps after user confirms (auto-selects or uses quoted protocol) |
| `get_mento_fx_quote` / `prepare_mento_fx` | Mento FX only |
| `get_gooddollar_reserve_quote` / `prepare_gooddollar_reserve_swap` | GoodDollar reserve (G$ ↔ USDm) only |
| `get_uniswap_quote` / `prepare_uniswap_swap` | Uniswap v4 only |
| `estimate_mento_fx` / `estimate_uniswap_swap` | Gas estimates (when user asks) |

Example: *"Swap 100 G$ to USDm"* → `get_swap_quote` selects **`gooddollar_reserve`** via MentoBroker — not Uniswap → user confirms → `prepare_swap` (or `prepare_gooddollar_reserve_swap`) → `TxConfirmCard` (optional approve + broker swap).

## GoodDollar

Wallet-signed UBI claims and **G$ ↔ USDm reserve swaps** via celina-sdk:

| Tool | Purpose |
|------|---------|
| `get_gooddollar_identity_link` | Root vs connected-wallet link on IdentityV4 |
| `get_gooddollar_whitelisting_info` | IdentityV4 whitelist and reverification status (root-resolved for connected wallets) |
| `get_gooddollar_ubi_entitlement` | Today's claimable amount, eligibility, blockers |
| `prepare_claim_daily_gooddollar_ubi` | Unsigned UBI `claim()` — user signs in wallet |
| `get_gooddollar_reserve_quote` | G$ ↔ USDm reserve quote (MentoBroker bonding curve) |
| `prepare_gooddollar_reserve_swap` | Unsigned reserve swap — user signs in wallet |

Example (UBI): *"Claim my GoodDollar UBI"* → `get_gooddollar_ubi_entitlement` → user confirms → `prepare_claim_daily_gooddollar_ubi` → sign in wallet. One claim per verified identity per day.

Example (reserve): *"Swap 100 G$ to USDm"* → `get_swap_quote` (or `get_gooddollar_reserve_quote`) → user confirms → `prepare_swap` → sign in wallet.

Requires `@andrewkimjoseph/celina-sdk` at the version pinned in `package.json`. Reserve **execute** (`execute_gooddollar_reserve_swap`) is MCP stdio only — Celeste uses `prepare_swap` + wallet signing. See [GoodDollar guide](https://andrewkimjoseph.gitbook.io/celina-sdk/guides/gooddollar).

Uniswap v4 CELO swaps route through WCELO — the connected wallet needs WCELO balance. Dismissing the confirm card does not re-prepare until the user sends a new message.

## Aave V3

Supplied balance reads and wallet-signed supply/withdraw via celina-sdk:

| Tool | Purpose |
|------|---------|
| `get_aave_balances` | Supplied positions (aToken balances) in underlying units including interest |
| `prepare_aave_supply` | Unsigned supply steps — user signs approve + supply in wallet |
| `prepare_aave_withdraw` | Unsigned withdraw step — user signs in wallet |

Example: *"What do I have on Aave?"* → `get_aave_balances` → concise summary. *"Withdraw all my USDT from Aave"* → `get_aave_balances` first, then `prepare_aave_withdraw` with `withdraw_max`. CELO supply requires wrapped CELO (ERC-20), not native CELO.

## Chat history

Chats are saved **locally in your browser** (IndexedDB via Dexie), scoped to the connected wallet address. Up to **50 threads** per wallet are kept; older threads are trimmed automatically. History survives page refresh but stays on this device — there is no server sync. Delete individual threads from the sidebar (desktop) or History drawer (mobile), or clear all site data in your browser.

## For developers

### Request flow

1. User connects wallet (wagmi + RainbowKit).
2. `ChatPanel` sends messages + `{ address }` to `POST /api/chat`.
3. `resolveTargetAddress` in `src/lib/chat-tools/schemas.ts` defaults tool inputs to that connected address (SDK always needs an explicit `0x…`; this is Celeste’s equivalent of Celina MCP’s optional-address session wallet on stdio).
4. LLM calls tools from `src/lib/chat-tools/` (reads via SDK, writes via `prepare_*`).
5. `prepare_*` tools return `SerializedPreparedFlow` from celina-sdk.
6. `ChatPanel` detects the flow in message parts and renders `TxConfirmCard`.
7. User confirms — `TxConfirmCard` simulates each step via SDK + Celeste MiniPay wrapper, then signs sequentially via wagmi; checks `receipt.status` after each mine.

Chat tools mirror **celina-sdk** reads and `prepare_*` wallet flows (naming is similar to celina-mcp for familiarity, but Celeste does not call MCP). Server-key writes (`send_token`, `execute_mento_fx`, `execute_uniswap_swap`) and **Self Agent ID** registration flows are only in [celina-mcp](../celina-mcp) or [`@selfxyz/agent-sdk`](https://www.npmjs.com/package/@selfxyz/agent-sdk).

### Directory map

| Path | Purpose |
|------|---------|
| `src/app/api/chat/route.ts` | Streaming chat route — wallet gate, tool wiring |
| `src/lib/chat-tools/` | Vercel AI SDK tool definitions (reads + prepare_*) |
| `src/lib/tx/swap-routing.ts` | Composite Mento FX + GoodDollar reserve + Uniswap v4 quote/prepare logic |
| `src/lib/chat/chat-model.ts` | OpenRouter / OpenAI model selection |
| `src/lib/wallet/celina.ts` | Server-side SDK singleton |
| `src/lib/tx/prepared-flow.ts` | Extract `SerializedPreparedFlow` from chat messages |
| `src/lib/minipay/minipay-fee-currency.ts` | MiniPay CIP-64 `feeCurrency` resolution (Celeste-only) |
| `src/lib/tx/prepared-step-simulation.ts` | Wraps SDK `simulatePreparedStep` + send preflight for sends |
| `src/lib/chat/chats.ts` | Chat thread types, title helper, tx-card UI state on load |
| `src/lib/chat/chat-db.ts` | IndexedDB CRUD for persisted chat threads |
| `src/components/chat/chat-context.tsx` | Wallet-scoped chat state + persistence |
| `src/components/chat/chat-sidebar.tsx` | Desktop thread list + wallet balances |
| `src/components/chat-panel.tsx` | Chat UI, address transport, tx card trigger |
| `src/components/tx-confirm-card.tsx` | Per-step simulate → send → receipt check; MiniPay `feeCurrency` on send when applicable |
| `next.config.ts` | Monorepo + bundler workarounds |

### Environment variables

See [`.env.example`](.env.example):

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter LLM (recommended) |
| `OPENAI_API_KEY` | Direct OpenAI (alternative) |
| `OPENAI_MODEL` | Model id (e.g. `openai/gpt-4o-mini` on OpenRouter) |
| `OPENAI_BASE_URL` | Override provider URL (optional) |
| `CELO_RPC_URL_MAINNET` | Celo RPC for SDK reads/prepare |
| `ETH_RPC_URL_MAINNET` | Ethereum RPC for ENS resolution |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect / RainbowKit |
| `NEXT_PUBLIC_AMPLITUDE_API_KEY` | Celeste browser product analytics (separate Amplitude project) |
| `NEXT_PUBLIC_AMPLITUDE_DISABLED` | Set to `1` to disable browser analytics |
| `NEXT_PUBLIC_AMPLITUDE_SERVER_ZONE` | Optional `EU` if your Amplitude project is EU-resident (default US) |

Browser analytics (`NEXT_PUBLIC_AMPLITUDE_*`) tracks product UX events (wallet connect, chat, tx funnel). Celina SDK server telemetry (`celeste_ai` `device_id`, connected wallet as celina-stats-api `user_id` via `runWithAnalyticsWallet`) is a separate stream for read-tool usage. Opt out in [`src/lib/wallet/celina.ts`](src/lib/wallet/celina.ts) with `analyticsEnabled: false` on `createCelinaClient()`.

### Next.js config notes

[`next.config.ts`](next.config.ts) includes:

- `serverExternalPackages` — keep `@andrewkimjoseph/celina-sdk` and `@mento-protocol/mento-sdk` out of the server bundle
- `turbopack.root` — points at the monorepo root when developing inside the hackathon workspace
- `@react-native-async-storage/async-storage` stub — MetaMask/RainbowKit dependency shim for web

Dev script uses `--webpack` for compatibility; adjust if Turbopack-only dev is preferred.

### Adding a chat tool

1. Add a `ToolDefinition` in **celina-sdk** — see [LLM tool catalog](../celina-sdk/docs/guides/tool-catalog.md) (`src/tools/domains/`, `surfaces: ["browser"]` or both).
2. Celeste wires tools through [`src/lib/chat-tools/sdk-adapter.ts`](src/lib/chat-tools/sdk-adapter.ts); add `ToolRuntime.hooks` there if the tool needs host-specific behavior (e.g. send preflight). Use **`dynamicTool`** when wrapping the catalog (documented in the SDK guide).
3. Update `buildSystemPrompt` in [`src/lib/chat-tools/system-prompt.ts`](src/lib/chat-tools/system-prompt.ts) if the LLM needs new rules.
4. Requires `@andrewkimjoseph/celina-sdk` at the version pinned in `package.json` with the `./tools` export.

### Transaction simulation

Before each wagmi send, Celeste dry-runs the prepared step so reverts surface in the confirm card instead of on-chain:

| Layer | Module | Role |
|-------|--------|------|
| SDK | `@andrewkimjoseph/celina-sdk/simulation` | Generic `simulatePreparedStep` — `publicClient.call` (or `estimateGas` when `feeCurrency` is set) |
| Celeste | `src/lib/tx/prepared-step-simulation.ts` | Host wrapper around the SDK helper |
| Celeste | `src/lib/minipay/minipay-fee-currency.ts` | Resolves MiniPay stablecoin gas (`feeCurrency`) for simulation + send |
| Celeste | `src/lib/minipay/minipay-spend-buffer.ts` | MiniPay gas buffer when fee token equals spend token |
| Celeste | `src/lib/tx/flow-preflight.ts` | Aave supply balance + gas buffer checks |
| Celeste | `src/lib/minipay/blocked-send-recipients.ts` | Blocks prepare_send to Aave pool and other protocol contracts |
| Celeste | `src/lib/tx/simulation-error.ts` | Friendly simulation failure copy (retry hints, allowance lag) |
| Celeste | `src/lib/tx/revert-error.ts` | Friendly on-chain revert copy (hash in technical details) |
| Celeste | `tx-confirm-card.tsx` | Send preflight (balance checks) for send flows only; simulate → send → `receipt.status`; resumes multi-step flows on retry |

Simulation failures show user-friendly messages (e.g. “Almost there” after a mined approve when the network preview lags) with a **Try again** action. Completed steps are remembered so retry continues from the next step instead of re-signing approve. On MiniPay, when network fees are paid from the same stablecoin being supplied or sent, Celeste reserves a small gas buffer so “supply all” flows fail at preflight/simulation instead of on-chain. Reverted transactions are not counted as completed steps.

Full guide: [Prepared-step simulation](https://andrewkimjoseph.gitbook.io/celina-sdk/guides/prepared-step-simulation) (SDK GitBook).
