# Story notes: Signoff

## The hook
A rebalancing dispatcher asks "which stations near Union Square need bikes?" and sends a truck and a crew on the answer. On our first pull of the live Citi Bike feed on 7 November 2026, 47 stations reported a last update in 1970, between 6 and 9 reported more bikes and docks than they physically have, and 27 to 29 installed stations had been silent for more than a day. Nothing in the dispatcher's room said so.

## What we built (two rooms, four agents, two people)
- Room #data-incidents: the watcher (role @monitor), the fixer (@remediator), the scribe (@recorder), Paras (data owner) and Harshita.
- Room #rebalancing-desk: the analyst (@dispatch-analyst), the watcher, Harshita (dispatch lead) and Paras.
- Rooms, roles, threads, room documents and the sign-off gate are all Switch features. Switch is an open-source platform from SandboxAQ that puts AI agents into Slack, Teams, Discord, Telegram and Mattermost rooms.

## The loop
1. Detect: every minute the watcher pulls the live feed and runs a 12-rule data contract. A new kind of failure opens one thread with evidence, handed to the remediator role.
2. Propose: the fixer replies with option A, why, a preview of exactly what changes ("47 stations stay out of the dispatch view, 22 of them in Manhattan below 96 St"), and option B.
3. Decide: only the data owner can approve. When Harshita typed "@fixer approve INC-001", Switch refused on the fixer's behalf: it only takes instructions from its owner. The gate is the platform's addressing policy, not our code.
4. Apply: a standing rule, written in one transaction with the approver's name. Nothing is deleted.
5. Verify: the watcher checks the next run; every failing station handled, zero unhandled; the incident closes.
6. Record: the scribe writes a postmortem as a room document.
7. Gate: before every answer the analyst reads the room's data-status document. Untrusted: "I won't send a truck on this data", with the reasons. Caveated: an answer that names every open incident. Trusted: an answer with stations cited [1] to [5].

## The frozen feed
We simulated the vendor's feed freezing (labelled as a simulation). The watcher opened a feed-level incident within one run and the analyst refused to dispatch. Paras signed off a bounded fallback: answer from the last good data, state its age, for up to 30 minutes. The desk got a caveated answer saying "data 5 min old". When the feed recovered, the watcher closed the incident by itself.

## Why it matters
- Monte Carlo's 2023 survey: data quality issues affected about 31% of revenue and took about 15 hours per incident to resolve.
- Sambasivan et al. (CHI 2021): data cascades in 92% of high-stakes AI projects, "invisible, delayed, but often avoidable".
- Gartner (June 2025): over 40% of agentic AI projects expected to be cancelled by end-2027, citing cost, unclear value and inadequate risk controls.
- EU AI Act Article 14: people overseeing high-risk AI must be able to understand, override and stop it.
- Levels of automation (Parasuraman, Sheridan & Wickens, 2000): Signoff sits at "the machine proposes, the human approves, then it executes".

## What we learned
- The gate belongs in the platform. We deleted our own "if sender is owner" check because Switch's addressing policy does it better and holds for every agent added later.
- Hand off to jobs, not names. Addressing @remediator instead of @fixer lets us swap the agent behind the job.
- A room document is a contract between agents. The analyst never calls the watcher; it reads data-status, which a person can read too.
- A silent watcher is a failed watcher: no run in 3 minutes makes the data untrusted.
- Connections drop under load; reconnect with the same id, resume from the cursor, re-take the room and the role.

## How to try it
- Live app in the browser, on today's feed: https://parasadlakha.github.io/signoff/live/
- Replay of the recorded Switch session: https://parasadlakha.github.io/signoff/app/
- Run the full Switch version with five commands: https://github.com/ParasAdlakha/signoff

## Thank you
WeMakeDevs (Kunal Kushwaha and the team), DevTools Academy, the Switch team at SandboxAQ, Wispr, and the mentors, judges and Discord community.
