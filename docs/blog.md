# Your first Switch room with a sign-off gate: four agents, two people, and no SDK

*By Paras Adlakha and Harshita Adlakha · Flip the Switch Hackathon, November 2026*

We wanted to see how far Switch's own primitives go before you have to write any glue. We built **Signoff**: a team chat where AI agents catch bad data, prepare the fix, and wait for a named person to approve it. A dispatcher in a second room asks an agent where to send a truck, and gets an answer gated on whether the data can be trusted.

This post is the guide we wish we'd had on day one. It covers running Switch locally with no Slack workspace, registering your own agents, speaking the agent protocol with no SDK, and the five Switch features that ended up doing most of the work. The code is at [github.com/ParasAdlakha/signoff](https://github.com/ParasAdlakha/signoff).

---

## 1. Run Switch locally, headless, in one command

Switch Console is the easy path on macOS. We were on Windows, and we wanted judges to be able to reproduce everything from a terminal, so we used the standalone Compose stack the Console itself runs. It's published in the Switch repo as `deploy/local/standalone-docker-compose.yml`, and it's a versioned contract: service names and env vars are stable per release.

```bash
# .env: copy .env.example, set SWITCH_VERSION=0.31.0, fill the blank secrets with random values
docker compose --profile collab --profile gateway up -d
curl localhost:8000/health        # {"status":"ok"}
```

The `collab` profile brings **Mattermost** with it, plus a `setup` container that creates a team, an admin and a user, and links the Switch admin to the Mattermost user `user`. That last detail matters later: **agents you register as the admin are owned by the person behind `user` in Mattermost.**

Two things that tripped us up:

- `SWITCH_VERSION` has no default on purpose. Pin a real release. The newest stable `switch-core` image on GHCR was `0.31.0` when we built this.
- The Gateway defaults to port 3000, which is often taken. Set `GATEWAY_HOST_PORT` and `FRONTEND_BASE_URL` together.

## 2. Register agents with a registration key, not the bootstrap token

The deployment has a bootstrap key (`AGENT_REGISTRATION_TOKEN`), but agents registered with it belong to a special "Agent Bootstrap" account, so they won't answer *you* by default. Sign in to the Gateway and create your own registration key instead:

```js
await fetch(`${BASE}/gateway/auth/login`, { method: 'POST', body: JSON.stringify({ email, password }), ... }); // cookie session
const { key } = await gw('POST', '/api-keys', { label: 'signoff agents', expires_in_days: 'never' });

const r = await fetch(`${BASE}/agents`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'fixer', display_name: 'Fixer', description: '…', connector_type: 'signoff-node',
    integration_profile: { connection_model: 'always_on', message_exchange: true,
      pre_invocation_mediation: [], post_invocation_mediation: [], event_reporting: [] },
  }),
});
const { id, api_key } = await r.json();   // the api_key is shown once: store it
```

## 3. Speak the protocol: one WebSocket, answer every ping

There's no client library, and you don't need one. Node 22's built-in `WebSocket` can send the `Authorization` header:

```js
const ws = new WebSocket(`${WS}/agents/${id}/connection/ws?connection_id=${uuid}&scope=all&filter=all`,
  { headers: { Authorization: `Bearer ${api_key}` } });

ws.onmessage = ({ data }) => {
  const f = JSON.parse(data);              // every frame is {event, data[, id]}
  if (f.event === 'ping') return ws.send(JSON.stringify({ type: 'pong', cursor }));
  if (typeof f.id === 'number') cursor = Math.max(cursor, f.id);
  if (f.event === 'message' && f.data.payload.addressed) handle(f.data);
};
```

What the docs say and we learned the hard way:

- **Control frames arrive as `{event: "ping", data: {}}`**, not `{type: "ping"}`. Ours didn't pong at first, and the server evicted us every six seconds with a polite `heartbeat_lapsed`.
- **A connection outlives its socket, but your room claim doesn't.** After a reconnect, call `connect_to_room` again and re-take your role. Otherwise the next `post_message` fails with *"Not connected to a room"*.
- **Act only on `payload.addressed`.** You receive everything in your rooms. Delivery and acting are different things.
- **Operations are plain HTTP:** `POST /agents/{id}/ops/{name}` with the `X-Switch-Connection-Id` header and the arguments as the body. `GET /agents/{id}/ops` lists all of them with their schemas.

## 4. Let an agent build the rooms

An agent can create a room in Mattermost with people, agents, instructions, roles and links in one call:

```js
await op('create_room', {
  name: 'data-incidents', description: '…', channel_type: 'channel_public',
  agent_names: ['watcher', 'fixer', 'scribe'], user_names: ['user', 'harshita'],
  instructions: 'Every incident is one thread… never applied until the data owner replies…',
  roles: [{ name: 'remediator', exclusive: true, instructions: 'You propose one remediation per incident…' }, …],
  write_visibility: 'private',
});
```

The room's **instructions** are read by every agent when it joins, including agents someone adds next month. That's where the team's rules live.

## 5. The five features that did the work

**Roles instead of names.** The watcher never addresses `@fixer`. It addresses `@remediator` with `send_targeted_message({ target_roles: ['remediator'] })`, and whichever agent holds that exclusive role answers. When we swap the fixer for a coding agent run by Switch Console, nothing else changes.

**The addressing policy is the sign-off gate.** We set the fixer to `owner_and_owner_agents` (via `update_agent_detail`, called by a sibling agent, because an agent can't change its own settings). When Harshita types `@fixer approve INC-001`, the message never reaches our code. Switch replies on the fixer's behalf: *"I only take instructions from my owner…"*. We'd written an `if (sender === owner)` check first and deleted it: the platform's version is visible in the room and applies to every agent we'll ever add.

**Threads as the unit of work.** One incident, one thread: evidence, proposal, decision, verification and postmortem all reply to the root. `post_message` takes a `thread_id`, and the root's `event_id` works as one.

**Room documents as the contract between agents.** The analyst never calls the watcher. The watcher keeps a `data-status` room document in the desk room (`create_room_document`, then `update_room_document`), and the analyst reads it with `load_internal_documents` before every answer. A person can open the same document, so the trust state is explainable for free. One tip: **every update posts a notice in the channel**, so only write when something actually changed.

**Linked rooms.** `#rebalancing-desk` links to `#data-incidents` with the label *"data health: incidents on the tables this desk dispatches from"*, and back with *"downstream"*. An agent connecting to either room gets the link in `connect_to_room`'s `linked_rooms`, with whether it's a member there.

## 6. What it looks like

The watcher pulls the live Citi Bike feed every minute and runs a 12-rule data contract. On its first run it found 47 stations reporting a last update in 1970, 9 with more bikes than docks, and 27 silent for a day, and opened three threads. The fixer replied in each with a proposal, a preview (*"47 stations stay out of the dispatch view (22 of them in Manhattan below 96 St)"*) and an alternative. Paras approved one with `@fixer approve INC-001` and picked the alternative for another with `@fixer approve INC-003 B`. The watcher verified each on its next run and closed it, and the scribe wrote the postmortems as room documents. At the desk, the analyst went from *caveated* to *trusted*. When we simulated the feed freezing, it refused outright: *"🛑 I won't send a truck on this data."*

## 7. If you're starting your first Switch project

1. Run the standalone stack with `collab`, and use the bundled Mattermost. You don't need a workspace or an admin.
2. Create a registration key in the Gateway. Don't register with the bootstrap token.
3. Get one agent answering pings and posting to one room before you write any logic.
4. Put your rules in **room instructions** and your jobs in **roles**. Address roles, not names.
5. Use the **addressing policy** for anything that needs a human's approval.
6. Share state through **room documents**, and write them only when they change.
7. Plan for reconnects from the start: same `connection_id`, resume from your cursor, re-claim your room, re-take your role.

Switch's docs MCP server helped too: add `https://docs.switchagents.ai/mcp` to your coding agent as an HTTP MCP server and ask it how Switch works.

## Thank you

Thank you to WeMakeDevs (Kunal Kushwaha and the team), DevTools Academy, and the Switch team at SandboxAQ for hosting Flip the Switch and for building Switch in the open. Thank you to Wispr, to the mentors, judges and moderators, and to everyone in the WeMakeDevs Discord who helped other builders get set up.

*#HowISwitch*
