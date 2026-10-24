# Правила направления и оценка: решения по ходу сборки

Сборка по плану `docs/superpowers/plans/2026-10-24-direction-scoring.md`, 24.10.2026, PR #62. Каждое решение: что решено, почему, чем грозит, если неверно. Ниже отложенные мелочи из независимой проверки.

## Решения

- Task 1: Ruling: plan said weightedScore example = 59, the sum 24+15+10+6+3 is 58 | test expects 58 | cost if wrong: none, arithmetic
- Task 2: Ruling: a failed haiku call also goes to sonnet (not only a borderline one); null only when both fail | spec: «null, если оба вызова не удались» | cost if wrong: one extra sonnet call per failure
- Task 3: Ruling: LeadCard.score is optional (`score?:`) so existing callers and fixtures keep compiling | cost if wrong: none
- Task 3: Ruling: any error in the score step (no rules, a throw) gives an unscored card instead of failing the workflow | spec «Заявка не теряется из-за сбоя модели» | cost if wrong: a broken rules table shows as «Без оценки» cards rather than an alarm
- Task 3: Ruling: a reminder card shows the stored score if any, else only the sorter line (no «Без оценки» line) | cost if wrong: a reminder of an unscored card loses its mark
- Task 5: Ruling: answerQuestion only matches open (unanswered) questions, also for a reply | a reply to an answered question gets «Пока я понимаю…» | cost if wrong: Boris cannot correct a reason by replying again
- Task 6: Ruling: createTranscriber takes a `workDir` for the converted wav (plan had none) | temp files need a place in /data/voice | cost if wrong: none
- Task 6: Ruling: whisper.cpp pinned to v1.9.4 (released 2026-09-11; v1.9.5 of 2026-10-06 is too new), GGML_NATIVE build arg (ON on the server, OFF for a Mac check), libgomp1 added to the image; model sha256 checked against the huggingface API (1be3a9b2…) | cost if wrong: an image rebuild
- Task 6: Ruling: the voice handling lives in learning/inbox.ts (handleBorisMessage), the bot only downloads the file | cost if wrong: none
- Task 6: Ruling: the Telegram text handler ignores messages starting with «/» (commands) | cost if wrong: none
- Task 7: Ruling: dailySummary returns 'not_yet' before 19:00 (the plan listed only sent/none/already) | cost if wrong: none
- Task 7: Ruling: summary lines and buttons are numbered («1. …», «Взял бы №1») so several «Взял бы» buttons can be told apart | cost if wrong: wording only
- Task 7: Ruling: a summary that fails to send frees the day (job_run row and review tasks removed) so the next tick retries | cost if wrong: a summary twice if Telegram accepted it but answered an error
- Task 7: Ruling: «Взял бы» answers «Прислала карточку заявки» and sends the card itself (new lead_decision task with its decision wait) | cost if wrong: none
- Task 7: Ruling: StartOptions.learningTickMs added so e2e tests are not raced by the minute tick | cost if wrong: none
- Task 8: Ruling: «not twice a day» guarded by job_run ('proposal:<account>', Moscow day), taken only after the other conditions hold, kept even when the model call fails or returns broken rules | cost if wrong: a failed day waits until tomorrow
- Task 8: Ruling: RulesProposalOutput.rules uses DirectionRulesShape (no cross-field refines) so the model gets a schema; the code then checks DirectionRules | cost if wrong: none
- Task 8: Ruling: backtest scores carry version = from_version + 1 (the would-be version) | cost if wrong: confusing only if the proposal is declined and another v+1 is made later; rows are backtest=true
- Task 8: Ruling: a stale «Применить» (rules changed meanwhile) marks the proposal declined | cost if wrong: none
- Task 8: Ruling: a «Не надо» reason lives only in core.question (rule_proposal has no reason column) | cost if wrong: the proposer does not see past refusals yet
- Final: Ruling: a proposal whose send failed keeps the day used (no retry until tomorrow) | avoids a model call and 100 haiku calls every minute while Telegram is down | cost if wrong: a proposal a day later
- Final: Ruling: during a Claude limit every order comes as a «Без оценки» card | spec 4.3 chose «never lose an order»; flagged to Boris as a risk | cost if wrong: a flood of cards on a limit day
- Final: Ruling: a haiku stop factor with high confidence is final, stop-factor drops skip the summary | spec 4.2/4.5 | cost if wrong: a wrongly stopped order unseen
- Final: Ruling: a reply to an answered question or to a non-question message is not a reason | spec 4.4 | cost if wrong: Boris retypes
- Final: Ruling: «Пропустить» after «Взял бы» keeps the first label (yes) | plan rule | cost if wrong: one mislabeled example
- Final: Ruling: a crash between the job_run insert and the send gives no summary that day | insert-first design | cost if wrong: one missed summary on a crash at 19:00
- Final: Ruling: no reminder for an unanswered proposal; summary N counts Scorer drops only; a late summary after downtime may come after 23:00 | spec silent | cost if wrong: minor
- Final: Ruling: a client's name inside the order text can reach the model | same as the Sorter; ADR-016 covers the name field | cost if wrong: privacy exposure as today
- Final: Ruling: DBOS replay of old processOrder runs with new steps | leads pipeline is off in production, no in-flight runs | cost if wrong: a stuck old workflow
- Task 9: Ruling: the gate failed at threshold 56 (69%, 5/23 responded dropped); at 50 it passes (87%, 2/23). The threshold is part of the rules, so it waits for Boris's yes (FR-MIND-3); leads:on waits too | cost if wrong: leads:on a little later

## Отложенные мелочи

- Final: minor (deferred): 8 schema-shape failures of the proposer journal as model.failed, not rules.proposal_invalid
- Final: minor (deferred): 9 Russian plural «1 решений», terse summary head
- Final: minor (deferred): 10 model/whisper text can carry the long dash (U+2014) to Boris
- Final: minor (deferred): 12 backtest runs inside the learning tick and shares gateway slots
- Final: minor (deferred): 13 the proposer never sees declined proposals and Boris's reasons
- Final: minor (deferred): 14 askWhy daily cap can be exceeded by a race of two simultaneous surprises
- Final: minor (deferred): 15 the «Взял бы» card is sent outside a DBOS step
- Final: minor (deferred): 16 scorer-dropped orders get no lead.sorted event
- Final: minor (deferred): 17 scoreEvalCli header says «active rules», uses RULES_V1
- Final: minor (deferred): 18 spec 5.3 chain is split across two tests
