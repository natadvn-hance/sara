# snippet-first (24.10.2026): select by the board, open the page only for leads that pass

Branch `claude/snippet-first-9d9386`, worktree `.claude/worktrees/snippet-first-9d9386`. Plan: `docs/superpowers/plans/2026-10-24-snippet-first.md`.

## What changed (short)

**Node (`apps/profi-node`)**
- A board order (`fromSiteAnswer`) is a plain `order` signal now (no `needsPage`). `eyes.ts` sends `profi.order_seen` at once: board title, text, client name if the board has it, budget, `published_at`, fee 0 (= unknown). The `waiting` map, `settleOrder`, `ordersWantingPage` and `withBoard` are gone; `withFee` keeps only the page answer's fee for a page read as the fallback.
- `insurance.ts` `readNewOrders`: opens feed page links only while the board is silent (`boardWorks()` false), as before. A board order is never opened by the minute check.
- `eyes/clientInfo.ts`: `clientInfoFromAnswer(body)` reads the `getKlientInfo` answer (`data.name`, `data.title`, `data.labels`, `data.reviews.count`, `data.reviews.list[].tags`) into `ClientInfo`. Contacts never leave it. The form of labels/tags is a GUESS (strings or objects with text/title/name/label both read), the answer was not seen in this repo (only the main session's description).
- `bid/bidTools.ts` `getOrder`: while the order page is open it takes the client answer of THIS visit (listener registered before the page load, removed after; counted only when the asking frame's address is this order's page, `?o=<id>`), waits up to `clientMs` (3 s) after load. Also reads the page text for the client name/text when the board lacked them (board wins), takes the name from the client answer as the last resort, writes the bid form map (`keepFormMap`) and hands the page to the form calibration (`BidRuntime.afterOrderPage`, wired in `service.ts`), because the minute check no longer opens board orders.
- `profi.get_order` output now has `client_info` (null when the page was read but gave none; absent when the tab may not move and the stored order is returned).

**Core (`apps/core`)**
- `profi/client.ts`: `getOrder(accountId, orderId)`, timeout 90 s (`getOrderTimeoutMs`), the node queues it behind the minute check.
- `leads/pipeline.ts` `processOrder`: after the Scorer shows and BEFORE the Analyst: `DBOS.patch('order-page')`, steps `orderPage` (node call, never throws: a failure is `{ok:false,error}`) and `orderPageStored` (lead update + journal `lead.page_read` {ok, open, has_bid, fee_rub, client_info, error}, no client words). Closed: status `closed`; `has_bid`: status `bid_already`; both end the run (no card, no Analyst), `lead.sorted` is journaled for them. Failure: the card goes on with board data, fee 0 shown as «Отклик: цена неизвестна», button «Откликнуться» without a sum.
- «Взял бы» (`draftThenCard`) reads the page too (a dropped order never had it): closed/bid_already ends the new decision task with a text to Boris instead of a card.
- `leads/draft.ts`: the Analyst input gets one line `Клиент на площадке: ...` from `client_info` (never the name).
- `notify/cards.ts`: fee 0 = unknown (text and button). `cardFlow.ts`: two texts.
- `roles/sorter/role.md` version 1 (triage principles of old `batchTriagePrompt.js`), 8 new eval samples (`tests/fixtures/orders/90000011..18`), `90000005` (Direct setup) now expected `reject`.
- `lead.page_read` in EVENT_TYPES.

**Fakes**: stand-in site: `POST /backoffice/api/` `getKlientInfo` per order (`SiteOrder.klient`, `klientDelayMs`, `klientDecoy` frame widget). Fake node: `getOrder` answers the emitted order (open, not bid on) or a page set by `setOrderPage(id, {open, has_bid, bid_price_rub, client_name, text, client_info, fail, delayMs})`; `orderReads` lists the reads.

## After the Opus review (24.10.2026, no Critical, 4 Important fixed)
- `GetOrderOutput.from_page` (new optional contract field): true only when open/has_bid/fee come from the page read now. The node's stored-order answer (tab may not move, page gave no order answer) is `from_page: false`. The core counts only `from_page === true` as a read page (`lead.page_read` `ok:false, error:'NOT_READ'` otherwise; an older node without the field is the same). Before, a stored answer passed as a read page and let closed orders through.
- `closed` only on the site's own word: `disabledBidBlock` in the order answer (`OrderScreen.disabled`), or, when the page gave no answer, a closed notice on the page (`closedNotice`). A missing form is NOT closed any more (a changed layout would otherwise drop every lead silently). The disabled block's title stays in `node.raw_event` (the recorded answer), not in the journal.
- `has_bid` is checked before `open` (an order we bid on may show no form).
- Latency: `inTab` now returns the work's answer BEFORE the tab goes back to the feed, `later(errand)` runs the form map + calibration after the answer (still on the page), the page text is read only when the board lacked the text or no client name came from the client answer. Tests that look at the tab after the work flush with `await ins.inTab(async () => null)`.
- Analyst role: paragraph about «Клиент на площадке» (use for risks/condition, never in the text), version 2.
- `draftThenCard`: the task end is guarded by `.returning()`; the variable `full` in processOrder is `withPage` now.
- Speed report: lead.found now comes at once and the page read is INSIDE lead.found -> task.created / card.sent (before, the node read the page before sending order_seen). G1 (lead to card, 2 min) will read longer after deploy for that reason, not because of a slower Sara.
- Not done on purpose: «Показать» (held order shown from the 19:00 summary) does not re-read the page; its press must answer Telegram at once and the existing test fixes its text. The node still refuses a bid on a closed order at the press.


## Board scroll (25.10.2026, asked by the main session after live data)
Live finding: the board answer (`boSearchBoardItems`) holds ~17 of 346 orders by relevance, not time; only 60% of orders reached the core within a minute.
- `eyes/insurance.ts` `scrollBoard`: after the feed page is loaded and read, the pass scrolls the board with the mouse wheel (mouse over the list, 450-700 px steps, a look of 0.7-1.3 x `pauseMs` between pages) until the PAGE asks the site for its next part; no GraphQL by hand. 4 pages a pass (the page's own first one included), every 10th pass up to 30 pages, never longer than 50 s, stops at the end of the board (`nextCursor` null), when the tab may not move (gate) or when nothing loads (`quiet`). Defaults in `BOARD_SCROLL`, overridable by `startInsurance({ board })`. Only when the eyes know the board and it has more pages.
- `ParseResult.more` (board answer has `nextCursor`), `Eyes.board()` = `{ seq, more }`; the counter moves AFTER the answer's orders are stored, so a pass that saw the answer leaves nothing behind.
- Each scroll pass writes a note to `node.raw_event` (`kind dom`, `what: board_scroll`, `pages`, `wanted`, `more`, `stoppedBy`, `ms`): no order, no text. Check after deploy: `select received_at, body from node.raw_event where kind='dom' and body->>'what'='board_scroll' order by received_at desc limit 20;` If most say `stoppedBy: quiet` the wheel does not make the live page load more (the list may sit in its own scroll box that the mouse is not over, or load by another trigger): then calibrate `scrollBoard`.
- Stand-in site: `boardPageSize` pages the board by cursor and the feed page loads the next one when scrolled (rows 420 px tall like live snippets). Tests: `apps/profi-node/test/boardScroll.test.ts`. Run under `node --import tsx` too (20 orders from 4 pages of 5).
- Costs to know: the first full pass (10th minute after start) can send up to ~300 orders the node never saw: older than 24 h ones are marked `stale` by the core without a model call; those within 24 h but not on the top pages go through the Sorter (Haiku) and Scorer, so a one-time burst of model calls. Their cards would be up to a day late (FR-LEAD-10 allows 24 h). A full pass holds the one tab up to 50 s: `get_order` of a lead waits behind it (the core waits 90 s, then goes on with board data).

## DBOS compatibility (WORKFLOW_VERSION stays '1')
`DBOS.patch('order-page')` goes right before `DBOS.patch('analyst-draft')`. checkPatch: an existing non-matching step at the position makes it return false without using a function id, so runs recorded before this deploy (their step there is the analyst-draft marker or the task step) skip the page read and resume as before; runs that had not reached that position get the new step.

## Things to know after merge
- Node and core must deploy together in practice: an old core + new node still works (fee 0, sorted by board data, no page read); a new core + old node: `get_order` gives the stored order (fee 0, no client_info), the card says «цена неизвестна».
- `get_order` is a tab visit per lead that passed the Scorer: a burst of leads queues in the node's one tab (each visit ≈ 5-15 s); the core waits 90 s, then goes on with the board data (fee unknown). Watch `lead.page_read` with `ok:false`, runbook RB-18.
- Open risk: the real `getKlientInfo` request/answer shape is unseen here. Check after deploy: `select count(*) from core.event where type='lead.page_read' and (payload->>'client_info')::bool` should grow; if `client_info:false` on every ok read, the shape guess is wrong (look at `node.raw_event` bodies with `data.reviews`).
- node.raw_event keeps `getKlientInfo` bodies with client contacts (the recorder redacts keys like `phone`, but not every contact field). Worth a look separately (ADR-022).
