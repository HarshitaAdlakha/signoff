# Submission texts

Copy-ready answers for the Flip the Switch submission, the live demo script, the blog and the social posts.

---

## Submission

**Project name:** Signoff

**Track:** 01 · Best Business Workflow (side tracks: Best Blog, #HowISwitch)

**Tagline (one line):** AI agents catch bad data in the team chat, a person signs off on the fix, and nothing downstream acts on data nobody trusts. Built on Switch.

**Team:** Paras Adlakha, Harshita Adlakha

**Repository:** https://github.com/ParasAdlakha/signoff (mirror: https://github.com/HarshitaAdlakha/signoff)

**Demo video:** https://github.com/ParasAdlakha/signoff/blob/main/docs/video/Signoff-demo-2min.mp4

**Live app (in the browser, today's Citi Bike feed):** https://parasadlakha.github.io/signoff/live/

**Live replay of the recorded Switch session:** https://parasadlakha.github.io/signoff/app/

**Podcast and media:** https://parasadlakha.github.io/signoff/notebooklm/

**Project page:** https://parasadlakha.github.io/signoff/

**Slides:** https://parasadlakha.github.io/signoff/slides/Signoff-slides.pdf

**Blog post:** https://github.com/ParasAdlakha/signoff/blob/main/docs/blog.md

**Description:**

> A rebalancing dispatcher asks where to send a truck, and the answer is only as good as the station data behind it. On our first pull of the live Citi Bike feed, 47 stations reported a last update in 1970, several reported more bikes than they have docks, and 27 had been silent for a day.
>
> Signoff runs the people and the AI agents who own that data in two **Switch** rooms in Mattermost. In `#data-incidents`, the **watcher** runs a 12-rule data contract every minute and opens one thread per incident, with evidence, handed to whoever holds the `remediator` role. The **fixer** proposes a remediation, previews exactly what it changes, and asks the data owner to sign off. Only the owner can approve it: the fixer's Switch addressing policy is owner-only, so when anyone else types `@fixer approve`, Switch refuses on its behalf. After sign-off, the fixer applies a standing rule with the approver's name, the watcher verifies it on the next run and closes the incident, and the **scribe** writes the postmortem as a room document.
>
> In `#rebalancing-desk`, the **analyst** reads the room's `data-status` document before every dispatch answer. When the data is untrusted it refuses ("I won't send a truck on this data"). When it's degraded it answers and names each open incident. Otherwise it answers, citing stations as [n].
>
> Switch is the workflow. Rooms, exclusive roles for hand-offs, the addressing policy as the sign-off gate, room documents as shared state, threads and linked rooms. The four agents speak the agent protocol directly, with no SDK and no npm dependencies. The Switch server, Postgres and Mattermost run from one Compose file pinned to 0.31.0, and the five commands in the README reproduce it from an empty machine.

**How we used Switch:** Two rooms created by an agent with `create_room` (people, agents, instructions, roles, links), bridged to the bundled Mattermost. Exclusive roles `monitor`, `remediator`, `recorder` and `dispatch-analyst`, with hand-offs through `send_targeted_message(target_roles=…)`. Addressing policies set with `update_agent_detail`: the fixer is `owner_and_owner_agents`, so Switch enforces the sign-off. Room documents (`data-status`, `incident-log`, `postmortem-INC-00x`) via `create_room_document`, `update_room_document` and `load_internal_documents`. One thread per incident, and linked rooms in both directions. Agents registered through a Gateway registration key, connected over the WebSocket (ping/pong, resume from cursor, re-claim room and role after a drop), operations over HTTP.

**Would it stop working without Switch?** Yes. The agents never call each other. Every hand-off, approval, refusal and piece of shared state is a Switch message, role, policy or room document.

**Data:** Citi Bike's public GBFS feed (about 2,520 stations, no key). The three station-level incidents in the demo are real. The frozen feed is a labelled simulation (`npm run inject -- stale`).

**Pre-existing components:** The record-level contract rules and the media scripts were adapted from our Spoke project (Supabase + Sodabase hackathon, 4 Nov 2026). The Switch setup, agents, rooms and workflow were built during this hackathon.


---

## Live demo script (3 minutes)

Have Mattermost open as `user` (Paras) in one window and as `harshita` in another, with the agents running.

1. **(20 s) The hook.** "A dispatcher sends a truck wherever the data says. On our first pull of the live Citi Bike feed, 47 stations said they last reported in 1970."
2. **(30 s) Detect and propose.** In `#data-incidents`, open INC-001: the watcher's evidence, then the fixer's proposal, preview and alternative, addressed to Paras.
3. **(30 s) The desk.** As Harshita: `@analyst which stations near Union Square need bikes?` Point at the caveats naming each incident, the [n] stations and the held-out count.
4. **(25 s) The gate.** As Harshita: `@fixer approve INC-001`. "Switch refuses: the fixer only takes instructions from its owner. That's Switch's addressing policy, not our code."
5. **(35 s) Sign-off.** As Paras, in the INC-001 thread: `@fixer approve INC-001`. Then the rule is applied, the watcher verifies on its next run, the incident closes, and the scribe posts the postmortem document.
6. **(30 s) Frozen feed.** `npm run inject -- stale`. INC opens at the desk. Ask again: "🛑 I won't send a truck on this data." As Paras: `@fixer approve INC-00x` (last good data, ≤30 min). Ask again: a caveated answer with the data's age.
7. **(10 s) Close.** "Signoff: AI agents catch bad data, a person signs off on the fix."

---

## LinkedIn post (Harshita, team voice)

Images in order: `docs/img/linkedin-cover.png`, `docs/img/linkedin-incidents.png`, `docs/img/linkedin-gate.png`. Or attach `Signoff-demo-2min.mp4`.

> "Which stations near Union Square need bikes?"
>
> A dispatcher sends a truck and a crew on the answer. So we asked: what if the data behind it is wrong?
>
> For the Flip the Switch hackathon, Paras and I built Signoff: AI agents and people working in the same team chat, on Switch, with live Citi Bike data. On its first run, our watcher agent found:
> → 47 stations reporting their last update in 1970
> → stations with more bikes than docks
> → 27 to 29 stations silent for over a day
>
> What happens next is the part we care about:
> 🔎 the watcher opens one thread per incident, with evidence
> 🛠️ the fixer proposes a fix and previews exactly what it changes
> ✍️ only the data owner can approve it. When anyone else tries, Switch itself refuses
> ✅ the fix is verified on the next run, and a postmortem is written to the room
> 🛑 at the dispatch desk, the analyst refuses to answer while the data can't be trusted
>
> My background is in system dynamics, and this is a feedback loop: the person deciding needs to know the data is wrong at the moment they decide, not in an engineer's alert channel the next morning.
>
> A huge thank you to WeMakeDevs and Kunal Kushwaha, DevTools Academy, and the Switch team at SandboxAQ for hosting Flip the Switch and for building Switch in the open. Thank you to Wispr, to the mentors, judges and moderators, and to everyone in the Discord who helped each other get set up.
>
> Where does your team find out the data was wrong: in the room where you decide, or the morning after?
>
> ▶️ Try it on today's live feed: https://harshitaadlakha.github.io/signoff/live/
> 💻 https://github.com/HarshitaAdlakha/signoff
>
> #HowISwitch #AIAgents #DataQuality #Hackathon #WomenInTech

## LinkedIn post (Paras, personal)

> The best line of code in our hackathon project is one we deleted.
>
> Our fixer agent had an `if (sender === owner)` check before applying a data fix. Then we found Switch's addressing policy: set the agent to owner-only, and Switch refuses everyone else before the message ever reaches the agent. The refusal is visible in the room, and it holds for any agent we add later.
>
> That's Signoff, built with Harshita for Flip the Switch: four agents and two people in two Switch rooms.
> 🔁 the watcher runs a data contract on the live Citi Bike feed every minute
> 🧵 one thread per incident, handed to a role, not a name
> ✍️ the fixer proposes; only the data owner can sign off
> 📄 the trust state is a room document the dispatch analyst reads before every answer
> 🛑 untrusted data → "I won't send a truck on this data"
>
> The agents speak Switch's WebSocket protocol directly, with no SDK and no npm packages, and the whole stack runs locally with Docker.
>
> Thank you to WeMakeDevs and Kunal Kushwaha, DevTools Academy, and the Switch team at SandboxAQ for hosting, to Wispr for supporting the event, and to the mentors, judges and the whole Discord community.
>
> If you run agents that can change data, where does your sign-off live today: in the platform, in your code, or in someone's head?
>
> ▶️ Live on today's Citi Bike feed: https://parasadlakha.github.io/signoff/live/
> 💻 https://github.com/ParasAdlakha/signoff
>
> #HowISwitch #AIAgents #DataEngineering #Switch #Hackathon

## X post (under 280 characters)

> Built Signoff for #HowISwitch
>
> AI agents catch bad data in team chat (47 Citi Bike stations "last reported" in 1970). Only the data owner can sign off the fix; Switch refuses everyone else.
>
> Thanks WeMakeDevs, DevTools Academy & the Switch team!
>
> github.com/ParasAdlakha/signoff


**Tags to add when posting** (type @ and pick the page or person on each platform): WeMakeDevs, Kunal Kushwaha, DevTools Academy, Switch (SandboxAQ), Wispr. Check each handle on the platform before posting.

## Code with Wispr (only if you used it)

Not entered: we didn't use Wispr Flow. If you do, attach the Insights scorecard screenshot from the Wispr Flow desktop app.
