# Edge Lab

[Project page](https://mysticalg.github.io/Edge-Lab/) · [Download for Windows](https://github.com/mysticalg/Edge-Lab/releases/latest)

## Linux and macOS

Portable downloads include Node.js 24.13.0 and production dependencies. Choose Linux x64/ARM64 or macOS Intel (darwin-x64)/Apple Silicon (darwin-arm64) from [Releases](https://github.com/mysticalg/Edge-Lab/releases/latest). Extract the `.tar.gz` into a writable folder, then run `./START_EDGE_LAB.sh` in Terminal (or `START_EDGE_LAB.command` on Mac). Open http://127.0.0.1:4178 and keep the terminal open. Data is stored in `data/` beside the app; preserve it when upgrading. If needed, run `chmod +x START_EDGE_LAB.sh START_EDGE_LAB.command`.

Public market feeds, research and paper strategies work on these platforms. **Authenticated Kraken account checks and real orders require Windows DPAPI and are unavailable on Linux/macOS.** No credentials are included.

From source on Linux/macOS, install Node.js 22+ (24 LTS recommended), then run `npm ci`, `npm run build`, and `npm start`. For development use `npm run dev`.

Native builds and tests run in the **Build Linux and macOS downloads** GitHub Actions workflow before release upload. A passing build verifies compilation and automated tests; desktop interaction on physical Linux/Mac machines has not yet been verified.


## Windows download

Download and extract the Windows x64 ZIP, then double-click `START_EDGE_LAB.bat`. The release includes Node.js and production dependencies; no separate installation is required. Open http://127.0.0.1:4178 after the server starts. Keep the console open while using the app. Extract to a writable folder; paper ledgers are saved in `data/` beside the app. This download contains no credentials or existing trading history.

For source development, follow the instructions below.

A local market research and paper-trading app. Its default **Kraken spot** tab streams BTC/GBP, ETH/GBP and SOL/GBP into a separate GBP paper account. Its **Latency scalper** tab tests single-outcome Binance-to-Polymarket lead/lag signals with delayed paper entries, bid-side exits, fees and realized/unrealized P&L. It also retains the earlier paired Up/Down strategy. **The Kraken live tab can submit manual real-money spot orders.** All automated strategies remain paper-only. Encrypted Kraken API credentials support account checks and manual orders; wallet seed phrases are never needed.

## Run on Windows

Double-click `RUN_EDGE_LAB.bat`. On first launch it installs Node dependencies, starts the local API and Vite, then opens `http://127.0.0.1:5178`. Node.js 22+ is required. Close the terminal to stop the app.

Or run:

```powershell
cd Edge-Lab
npm install
npm run dev
```

For a built app, run `npm run build` then `npm start` and open `http://127.0.0.1:4178`.

## Kraken spot

Public Kraken WebSocket v2 ticker subscriptions use `event_trigger: bbo`. Scans run on incoming updates; a 100 ms timer manages delayed fills and exits. Freshness requires a healthy stream, online exchange, and a best-level quote received within 10 seconds. Disconnects clear quotes and cancel pending buys. Pair status and order minimums come from Kraken AssetPairs (refresh every 10 minutes, expire after an hour).

- Separate £1,000 fictional account saved atomically in `data/kraken-paper-v1.json`. Previous Polymarket ledgers are preserved.
- Default £25 buy budget, 0.80% assumed taker fee each side, 5 bps adverse buffer each side, and 250 ms modeled execution latency. Uses current ask/bid after the delay; the whole quantity must fit the displayed best level. This is a limited depth simulation, not a guaranteed fill or L2 execution model.
- Automatic paper entries are off by default. Experimental long-only momentum requires a rise of at least 200 bps over about 60 seconds and a threshold above modeled round-trip costs. This is not arbitrage or evidence of a profitable strategy.
- One open position, 60-second entry cooldown, £10 daily realized-loss entry limit (UTC). Exits target £0.50 net profit, trigger at £0.75 net loss, or after 900 seconds. Existing trades keep their entry-time rules. Stale/thin bids block exits and make valuation unavailable; no proceeds are fabricated. Loss triggers do not guarantee a loss cap.
- Manual paper buys test accounting regardless of momentum. Stopping automatic entries still manages open exits. Settings and open trades survive restart; pending entries do not. No UI reset overwrites a ledger.
- Use **Check Kraken account** for optional read-only authenticated BalanceEx, TradeVolume and API permission checks. Both keys are Windows DPAPI encrypted for the current Windows user in `%LOCALAPPDATA%\EdgeLab\kraken-api-key.dpapi` and `kraken-api-secret.dpapi`, outside this repository and public files. Never put secrets in chat, source, logs or browser storage. The signing helper allows only the named account and spot-order methods used by the app; it exposes no withdrawals or arbitrary API proxy. API keys should be dedicated to this app; sharing keys between clients can cause nonce errors.
- Account checks show actual fee rates and GBP balance, separately from paper cash. Fees do not automatically rewrite existing paper trades. The live tab requires verified account permissions, fresh quotes, owned available assets and a validated order preview.

Sources checked 25 September 2026: [Kraken ticker v2](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), [fee schedule](https://www.kraken.com/features/fee-schedule), [REST authentication](https://docs.kraken.com/exchange/guides/rest/authentication). The published starting fee was 0.80% taker per side; use the account check for your actual rate.

## Manual real Kraken orders

The **Kraken live** tab is separate from all paper strategies. It starts disarmed after every backend restart. A preview is safe to request while disarmed: AddOrder is called with `validate=true` only, after funds and permission checks. The app cannot submit a real order until the user enables manual live controls, obtains a current preview, types the displayed pair/side confirmation and clicks **Submit real order**. The switch expires after 10 minutes. There is no automatic live buying or selling and no automatic live stop-loss.

- BTC/GBP, ETH/GBP and SOL/GBP only; unleveraged spot; £5–£25 per order; initial aggregate buy-submission budget £25 per UTC day. Canceled/uncertain buy submissions conservatively count against that daily limit. Sells use available owned crypto and can reduce holdings even after the buy limit is reached.
- IOC limit orders: best ask/bid with a 10 bps price tolerance, rounded to Kraken tick and volume precision. Price is capped for buys and floored for sells; available depth is rechecked. Remainders cancel, and partial fills are possible. Buys reserve verified taker fees plus a penny for rounding. Sell balance checks also reserve crypto in case Kraken charges fees in base currency.
- Available cash/crypto excludes order holds and borrowed credit. Funds, account fees, API permissions, quote freshness and bounds are checked again before submission. Requires Query funds, Query open and closed orders, and Create & modify orders. Withdrawal permission is unnecessary and is never used.
- Live order intents are atomically saved to `data/kraken-live-v1.json` before submission. A server-generated preview identifier prevents repeated submissions from double-clicks or replay. Timeouts or ambiguous responses never auto-retry: they block new submissions pending reconciliation by Kraken transaction/client order IDs. Unresolved history beyond the latest returned page may require checking directly on Kraken; the app does not assume absence proves rejection.
- Order status polls every 15 seconds only when this app has unresolved orders. Status, executed quantity and cost come from Kraken. Accepted is not filled; canceled can be partially filled. The app does not label executed sale proceeds as profit because existing holdings may have unknown cost basis.
- The live ledger CSV is distinct from paper CSV. Windows keys stay outside the repository and are only decrypted inside the local signing helper. Nonces are serialized across this server's private requests. Use a dedicated API key to avoid nonce conflicts with other applications.

Actual real-order placement has not been exercised during development. Unit tests use an injected API stub; live validation covered authenticated balances/fees/permissions and blocked insufficient-funds previews. No real order was placed. Manage any bought assets manually in the app or Kraken Pro.

## Latency scalper

This is an experimental approximation of the video's depicted strategy, not its unpublished algorithm. It watches the current BTC 5-minute contract. Default entry: Binance midpoint moves at least 2 bps (0.02%) over 2 seconds, while the corresponding Up or Down contract midpoint rises no more than 0.5 cents. This is an uncalibrated response heuristic, not a fair-probability model or proof of mispricing.

- Requires fresh connected feeds, synchronized history, a spread no wider than 2 cents, outcome ask between 5 and 95 cents, and enough displayed ask **and bid** depth for 10 shares. Estimated immediate round-trip costs must be below the stop-loss budget.
- Waits a modeled 250 ms before entry, then rechecks signal, cash and depth. Cancels if the average ask rises more than 0.5 cents. Trades are full-size hypothetical fills; partial fills and queue position are not modeled.
- Marks positions at sellable bid depth after the crypto taker fee estimate and 25 bps extra cost each way. Exits request another 250 ms delay: net profit of $0.25, net loss of $0.75, a 2 bps spot reversal, 45 seconds held, a manual close, or 15 seconds before expiry. These are exit triggers, not guaranteed fill prices or loss caps.
- Missing/stale bid depth leaves an exit pending and makes equity unavailable. A position held through expiry receives only its actual outcome payout after Gamma confirms resolution. Losing outcomes receive zero.
- Default controls: at most 2 open/pending positions, one position per market, 30-second market cooldown, and $20 daily net loss threshold (UTC, including open losses) to stop new entries. Exits continue when new entries are stopped.

The scalper has a separate $1,000 fictional account in `data/scalper-v1.json`, saved through serialized atomic file replacement. Entry attempts include cancellations; CSV exports contain completed and open trades. On first upgrade it inherits whether paired auto trading was enabled and stops new paired auto entries. Thereafter settings persist. Enabling either strategy stops automatic entries in the other. Existing positions and paired history are preserved. No fabricated TradingView/CryptoQuant/MiroFish signals are used.

## Paired quote calculation

The calculation walks both ask books for the requested equal share count. It adds Polymarket's current crypto taker fee formula on each level (`shares × 0.07 × price × (1 − price)`) and a user-set execution buffer in basis points. It subtracts these from the $1-per-pair settlement payout. A positive result is **only a quote observation**: neither leg was submitted, and the books can change before two fills. The calculation assumes one Up and one Down share cover every resolution and does not simulate rejected/partial orders or settlement delays. It uses Binance only as market context because these contracts resolve using Chainlink TWAP.

The app keeps up to 2,000 observations in `data/observations.json` and saves paper trades and settings in `data/paper-v1.json`. Both logs can be exported as CSV. No credentials are required.

## Paper trading

The Paper trades tab starts with a fictional $1,000 cash balance. Auto paper entries are **off by default**. Set paired shares, execution buffer, minimum estimated net profit, and maximum open pairs, then click **Start auto paper**. Auto entry requires fresh books, enough paper cash and ask depth, a net quote above the configured threshold, and no earlier paper pair for that market. On Monitor, **Enter paper trade** enters one manually even if the projected net is negative; this is useful for testing and shows that the model can lose. **Record quote only** saves an observation and does not enter a paper trade.

On entry, the app assumes both legs fill at displayed asks and debits paper cash for the shares, both taker fees, and the buffer. That is an explicit modeling assumption, not a verified fill. The trade stays open and its net remains **projected**. After the market ends, the app polls Gamma until it reports a resolved binary outcome (`Up` and `Down` priced `1` and `0`). Then it credits one USDC per paired share and labels the result **realized paper P&L**. Unresolved markets remain open. The ledger persists across restarts while `data/paper-v1.json` is retained.

The paired strategy watches four BTC 5-minute/15-minute markets using live WebSocket feeds while the app server runs. The separate scalper uses the current 5-minute market. Neither reproduces the video's claimed 50-market system. Faster data by itself cannot turn a negative after-cost quote into profit.

## Live streams and speed

- Polymarket sends initial full snapshots and incremental price/size changes for eight outcome tokens. Each entire frame is applied before the engine scans for paper entries, so a multi-leg frame cannot trigger a decision halfway through its updates.
- Binance's `btcusdt@bookTicker` stream supplies the current best bid/ask on each change. It drives the directional scalper signal and remains context only for paired quotes.
- Paper processing runs on source updates, independently of the screen. The scalper samples comparison history up to 20 times/second and evaluates new candidates up to 100 times/second; pending fills and exits are also checked by a 100 ms timer. Disk saves are queued without delaying the next market event. The chart samples history every two seconds, while its current price receives every event.
- The screen uses server-sent events, with snapshots coalesced to at most 20 per second (50 ms). A slow screen skips intermediate displays and cannot hold up the engine. **Pause display** pauses only the screen; the server and enabled auto paper entries continue.
- Both feeds reconnect automatically with backoff. A Polymarket disconnect clears all book depth; entries wait for fresh snapshots. Heartbeats detect silent connections. An unchanged book remains valid on the same healthy connection, while its original source timestamp is preserved.
- Gamma market discovery still runs every 20 seconds, updates subscriptions as contracts roll, and settlement checks run every 15 seconds. Neither sits in the stream's quote-processing path.
- The performance strip reports actual quote checks per second, processing p95 over the latest 512 scans, and heartbeat round-trip time. Source timestamp deltas depend on clock alignment and can be negative; they are not a reliable one-way network latency measurement. Screen delivery measures local server-send to browser-receive time and excludes the up-to-50-ms coalescing interval and rendering.

Connections: `wss://ws-subscriptions-clob.polymarket.com/ws/market` and `wss://stream.binance.com:443/ws/btcusdt@bookTicker`. Browser push: `/api/stream`. Diagnostic snapshot: `/api/state`. No API keys are needed. There is no silent polling fallback: a disconnected stream is visible and stale Polymarket books cannot enter paper trades.

Sources: [Polymarket trading fees](https://docs.polymarket.com/trading/fees), [Polymarket real-time data](https://docs.polymarket.com/market-data/realtime-data), [Binance WebSocket streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md). Check the selected market's own resolution description before drawing conclusions.

## Viral clip research

Frame inspection on 25 September identifies the **depicted** strategy as one-side BTC 5-minute latency scalping: the log shows entries while Polymarket lags Binance and exits when `PM caught up`, with TradingView/CryptoQuant filters. The chart explicitly says `SIMULATED`, and the displayed clock runs about 6.4 times faster than playback. This does not establish real execution, actual source integrations, or the claimed returns.

The “19-year-old Japanese student” wording, including the same $68 starting balance, $6,732 first-night profit, and $750,000 total, appears in [multiple reposts](https://ai.eond.com/threads/493343) and an [August 2026 build roundup](https://www.bestxbuilds.com/builds/claude-trading-bot). The reposts do not supply an attributable trader, audited account statement, or transaction ledger. The clip supplied with this project shows an animated dashboard, not independently verifiable fills. These findings do not prove the story false, but they give no basis for treating its return figures as evidence of an edge.


### Kraken trend paper experiment - September 25
Active preset: 15-minute trend of 50 bps, 60-second confirmation of 5 bps, maximum spread 20 bps, and four-hour maximum hold. At least 80% fresh history coverage is required. Eligible pairs are ranked by trend strength. Fees are charged at the configured rate, not inferred from historical momentum. Entries are blocked if immediate exit costs already exceed the loss trigger. Dashboard shows warmup, confirmation, blockers and fee-adjusted target distance. Existing positions retain their entry rules. This is an unproven paper experiment, not automatic live trading.

Meme paper universe: DOGE/GBP, PEPE/GBP and WIF/GBP alongside BTC/GBP, ETH/GBP and SOL/GBP. All remain in one GBP paper pool with one open position total. The comparison excludes manual trades and reports closed net P&L and worst closed trade, not independent backtested performance or portfolio drawdown. Fresh account taker rates are used per pair for new entries and locked into each position; after one hour new entries use the visibly labelled configured assumption until account rates are refreshed. Meme pairs are not added to the real-order allowlist.

### Read-only triangle scanner
Evaluates GBP-BTC-ETH-GBP and GBP-BTC-SOL-GBP in both directions with the paper budget. Requires fresh verified account fees for all legs (refresh with Check Kraken account). Uses best ask to buy and best bid to sell, applies configured buffers and fees in quote currency, rounds base quantity down, and checks minimum orders and full best-level liquidity. GBP dust is retained; crypto dust is excluded from returned GBP. Quotes are snapshot estimates, not simultaneous fills or credited profits. No triangle orders are submitted.

### Kraken maker paper experiment — September 26

Open **Kraken maker** to compare an all-taker triangle with a maker first leg using the same budget and taker buffer. This adapts the passive-entry idea to Kraken, without relying on access to Polymarket. Ordinary spot triangles have no fixed binary payout: a profitable quote is conditional on later fills and prices. This is not a reconstruction of PBot-6.

1. Select **Refresh Kraken maker / taker fees**. The existing encrypted account connection reads `TradeVolume.fees` and `fees_maker` separately. A missing maker rate is unknown, not zero. Every route requires account fees less than one hour old; no assumed discount or rebate is used.
2. Inspect the route checks. Default budget is £25; a route must exceed £0.10 conditional net after one maker fee, two taker fees and the taker execution buffers. A positive result does not imply an executable return.
3. Select **Start maker paper** to enable hypothetical entries in its separate £1,000 account. The experiment is off on first use and after every server restart. The Kraken spot and earlier paper ledgers remain independent.

The first order buys BTC, ETH or SOL at the current GBP best bid. After a default 250 ms entry delay it rechecks the route, fee and price, rejects a crossing post-only price, and joins behind twice the displayed bid quantity. Kraken's public `trade` channel is subscribed with `snapshot: false`. Only fresh, unique, sell-side trade updates at exactly the resting price consume this queue; snapshots, old/replayed prints, price touches and book cancellations do not. Trades more than two seconds old or more than one second ahead of local time are rejected. Both arrival and source time must clear a one-second guard after activation to avoid granting fills from early trades when clocks differ. This deliberately restrictive top-of-book model is not actual queue priority, L3 reconstruction or proof of a fill.

The first partial fill requests cancellation of the remainder with a further 250 ms delay; additional fills can occur during that delay. Filled shares debit their actual modeled cost and maker fee. Unfilled amounts only reserve paper cash. Once cancellation completes, the next conversion waits 250 ms, uses a fresh ask/bid plus the adverse buffer, checks minimums and full best-level quantity, then applies the verified taker fee in quote currency. Each leg happens on a separate delayed step. The simulator holds only assets it has acquired; it does not borrow or sell short.

The default order lifetime is 30 seconds. A changing quote or declining route estimate requests cancellation. A hedge exceeding five seconds, an observed net loss of £0.75, or a manual unwind requests a direct sale to GBP. Stale fees, stale/thin bids, restricted metadata or subminimum holdings block that sale; the inventory remains open and blocks new routes. The loss threshold does not cap losses. Disconnects cancel hypothetical quotes immediately because the observation gap cannot establish fills; existing holdings are retained for attempted unwind after recovery. Such gaps can understate real cancellation exposure.

One route can be open at a time, with a 60-second entry cooldown and a £10 UTC daily realized loss entry threshold. **Stop maker entries** cancels quotes after the modeled delay and continues managing inventory. **Stop and unwind paper inventory** also requests a direct GBP exit. Editing settings cancels the old quote; open cycles keep their original rules.

Paper cash, orders, fills, open holdings, closed GBP P&L and dust persist atomically in `data/kraken-maker-v1.json`. An unreadable or inconsistent ledger fails startup rather than resetting money. A save failure pauses the maker simulation. No maker component has access to the live order-submit function. CSV exports include all cycles or order attempts, while the screen limits recent history for responsiveness.

Equity uses current full-size GBP bid liquidation after taker fees and buffer. If that cannot be priced or traded, equity and open P&L are unavailable. Residual rounding dust is retained by currency but valued at zero and excluded from net GBP results. Rebates are zero. Maximum drawdown is the largest observed after-cost equity decline; missing marks can hide deeper losses. Both positive and negative route exits count in realized results. No positive simulated result demonstrates real execution or future profitability.

Sources checked 26 September 2026: [Kraken account maker/taker fees](https://docs.kraken.com/api-reference/account-data/get-trade-volume), [Kraken public trades and per-book trade IDs](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade).
