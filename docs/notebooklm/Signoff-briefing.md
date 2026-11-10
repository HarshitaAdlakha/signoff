# Systems & Business Briefing: Signoff — Human-in-the-Loop Governance for Agentic Data Workflows

**By Paras Adlakha and Harshita Adlakha**  
*Systems & Business Case File*

---

### Core Executive Message

AI agents can do the watching, the preparing and the writing-up of data incidents. The decision to change or trust data belongs to a named person, in the room where the work happens, with the evidence in front of them. Signoff shows this on live Citi Bike data: agents detect bad data and propose a fix, only the data owner can sign it off (enforced by Switch, not by our code), and the dispatch analyst refuses to send a truck while the data cannot be trusted.

---

## Executive Summary

Operational decisions across logistics, mobility, fintech, and retail are routinely made using degraded or corrupted data feeds. In high-stakes environments, automated systems and human operators frequently act on flawed inputs because traditional observability tools isolate data alerts inside engineering channels, away from downstream execution contexts.

**Signoff** is a systems architecture pattern designed to enforce human sign-off gates on autonomous agent actions. Developed for Track 01 (Best Business Workflow) of the Flip the Switch Hackathon (hosted by WeMakeDevs and DevTools Academy with Switch by SandboxAQ, 4–7 November 2026), Signoff deploys four AI agents and two human operators across two linked collaboration rooms in Mattermost using the open-source Switch platform.

Demonstrated live against North America's largest bike-share system—Citi Bike's General Bikeshare Feed Specification (GBFS) feed—Signoff validates incoming records every minute. On its first live pull on 7 November 2026, the system autonomously detected and quarantined multiple real-world defect patterns across 2,520 stations without human intervention, generated deterministic remediation previews, enforced access-controlled sign-off boundaries via platform-level addressing policies, and gated downstream dispatch operations until data integrity was verified.

```
       +-----------------------------------------------------------------------+
       |                         Citi Bike GBFS Feed                           |
       |                     (Live Public Data Source)                         |
       +-----------------------------------------------------------------------+
                                           |
                                           v (Every Minute)
       +-----------------------------------------------------------------------+
       |                           Watcher (@monitor)                          |
       |                     Runs 12-Rule Data Contract                        |
       +-----------------------------------------------------------------------+
                                           |
                                           v (Opens Thread + Evidence)
+-------------------------------------------------------------------------------------+
| ROOM: #data-incidents                                                               |
|                                                                                     |
|   Fixer (@remediator)  -----> Proposes Fix + Preview  -----> Asks Data Owner       |
|                                                                    |                |
|   Harshita (Dispatch)  -----> "@fixer approve INC-001" ----> [ REFUSED BY SWITCH ]  |
|                                                                    |                |
|   Paras (Data Owner)   -----> "@fixer approve INC-001" ----> [ APPROVED ]         |
|                                                                    |                |
|   Watcher (@monitor)   <----- Applies Standing Rule  <-------------+                |
|            |                                                                        |
|            v                                                                        |
|   Scribe (@recorder)   -----> Writes Postmortem Document to Room                    |
+-------------------------------------------------------------------------------------+
                                           |
                                           v (Updates Trust State)
+-------------------------------------------------------------------------------------+
| ROOM: #rebalancing-desk                                                             |
|                                                                                     |
|   Room Document: data-status [ Untrusted | Caveated | Trusted ]                     |
|                                                                    ^                |
|                                                                    | (Reads State)  |
|   Harshita (Dispatch)  -----> "@analyst where to send truck?" ---> Analyst          |
|                                                                    |                |
|                                Returns: Gated Answer / Refusal <---+                |
+-------------------------------------------------------------------------------------+
```

---

## Detailed Analysis of Key Themes

### 1. The Operational & Economic Reality of Unchecked Data

Modern operations rely heavily on real-time data feeds, yet data quality remains a persistent point of failure. The financial and operational impacts of raw feed degradation are documented across industry benchmarks:

*   **Financial Impact:** Gartner estimates the average cost of poor data quality at $12.9 million annually per organization. Monte Carlo’s 2023 industry survey revealed that data quality issues directly impact an average of 31% of organizational revenue.
*   **Resolution Latency:** Monte Carlo’s research indicates that data incidents require an average of 15 hours to resolve. In their 2022 survey, 75% of data professionals reported that detection alone took longer than four hours.
*   **Data Cascades:** Research by Sambasivan et al. (CHI 2021) across 53 AI practitioners revealed that 92% of high-stakes AI projects experienced "data cascades"—compounding downstream failures triggered by upstream data issues. The authors noted these failures were systematically "invisible, delayed, but often avoidable."
*   **Agentic Risk and Cancellation Rates:** Gartner (June 2025) projects that over 40% of agentic AI projects will be canceled by the end of 2027, citing unsustainable costs, unproven value, and inadequate risk controls. Furthermore, Article 14 of the European Union AI Act mandates that high-risk AI systems implement technical capabilities allowing human overseers to understand, override, or stop automated workflows.

#### Case Study: Citi Bike Operational Context
Citi Bike operates approximately 2,500 stations and logged 46.6 million rides in 2025. Fleet management depends on rebalancing trucks moving bikes continuously between full and empty stations, utilizing optimization models pioneered by O'Mahony & Shmoys (AAAI 2015). If an automated dispatch system consumes unverified station feeds, rebalancing crews are routed across Manhattan to service stations that were never actually empty.

| Metric / Requirement | Source / Standard | Value / Findings | Operational Impact |
| :--- | :--- | :--- | :--- |
| **Annual System Volume** | Citi Bike Operating Reports (2025) | 46.6 Million Rides | High frequency of physical operations based on digital state |
| **Average Cost of Bad Data** | Gartner Reference-Customer Survey | $12.9M / year | Direct bottom-line loss from operational errors |
| **Revenue Affected by Bad Data**| Monte Carlo Survey (2023) | 31% of revenue | Enterprise-wide impact across core business workflows |
| **Incidence of Data Cascades** | Sambasivan et al. (CHI 2021) | 92% of AI projects | Compounding downstream operational failures |
| **Agentic AI Project Drop Rate** | Gartner (June 2025 Prediction) | >40% by end-2027 | High cancellation rate driven by weak risk controls |
| **Regulatory Human Oversight** | EU AI Act (Article 14) | Mandatory Override | Legal requirement for human stop/override authority |

### 2. Multi-Agent Collaboration Architecture

Signoff establishes two discrete collaboration environments in Mattermost, managed via Switch (version 0.31.0), connected to a SQLite transactional warehouse enforcing database-level integrity constraints.

#### Room Layout and Role Distribution

1.  **`#data-incidents` Room:** Dedicated to feed monitoring, incident triage, and remediation governance.
    *   **Watcher (`@monitor`):** Executes a 12-rule data contract against the public GBFS feed every 60 seconds. Opens single-thread incidents for newly detected failure modes.
    *   **Fixer (`@remediator`):** Analyzes quarantined records, formulates remediation options, evaluates dry-run impact previews, and posts proposed solutions.
    *   **Scribe (`@recorder`):** Compiles postmortem artifacts into persistent room documents upon incident verification and closure.
    *   **Data Owner (Paras):** The single human authority empowered to sign off on database modifications.
2.  **`#rebalancing-desk` Room:** Dedicated to operational dispatch execution.
    *   **Dispatch Analyst (`@dispatch-analyst`):** Accepts dispatch queries from operators, evaluates the system trust state, and outputs gated location recommendations.
    *   **Dispatch Lead (Harshita):** Operational lead submitting dispatch queries.
    *   **Watcher (`@monitor`):** Maintains the `data-status` room document in the desk room to reflect current system health.

```
+---------------------------------------------------------------------------------------+
|                                    SWITCH PLATFORM                                    |
|                                                                                       |
|  +-------------------------------------+     +-------------------------------------+  |
|  | ROOM: #data-incidents               |     | ROOM: #rebalancing-desk             |  |
|  | Link: "downstream" -----------------+---->| Link: "data health"                 |  |
|  |                                     |     |                                     |  |
|  | Roles:                              |     | Roles:                              |  |
|  |   - @monitor (Watcher)              |     |   - @dispatch-analyst (Analyst)    |  |
|  |   - @remediator (Fixer)             |     |   - @monitor (Watcher)              |  |
|  |   - @recorder (Scribe)              |     |                                     |  |
|  |                                     |     | Room Documents:                     |  |
|  | Room Documents:                     |     |   - data-status                     |  |
|  |   - incident-log                    |     |                                     |  |
|  |   - postmortem-INC-00x              |     | Users:                              |  |
|  |                                     |     |   - Paras (Data Owner)              |  |
|  | Users:                              |     |   - Harshita (Dispatch Lead)        |  |
|  |   - Paras (Data Owner)              |     |                                     |  |
|  |   - Harshita                        |     |                                     |  |
|  +-------------------------------------+     +-------------------------------------+  |
+---------------------------------------------------------------------------------------+
```

### 3. Platform-Level Authority vs. Application-Level Logic

A core architectural principle of Signoff is offloading authorization and routing to the underlying platform infrastructure rather than maintaining custom application-level conditionals.

*   **Platform-Enforced Sign-off Gate:** The Fixer agent's addressing policy is configured to `owner_and_owner_agents` using Switch's native addressing controls. If unauthorized personnel (e.g., Harshita) attempt to approve a remediation by typing `@fixer approve INC-001`, the Switch platform intercepts the message before it hits application code. The platform responds directly on behalf of the agent: *"I only take instructions from my owner..."*
*   **Role-Based Abstraction:** Hand-offs are targeted at abstract roles (`@remediator`, `@monitor`, `@recorder`) via Switch's `send_targeted_message(target_roles)` protocol call. The underlying agent binaries can be swapped or updated without breaking inter-agent message routing.
*   **Decoupled State via Room Documents:** Agents publish state using native Switch room documents (`data-status`, `incident-log`, `postmortem-INC-00x`). The Dispatch Analyst agent reads `data-status` via `load_internal_documents` prior to processing dispatch requests, eliminating direct API coupling between monitoring and dispatch services.

```
+------------------------------------------------------------------------------------+
|                      SIGN-OFF ATTEMPT: UNAUTHORIZED USER                           |
|                                                                                    |
|  Harshita: "@fixer approve INC-001"                                                |
|     |                                                                              |
|     v                                                                              |
|  +------------------------------------------------------------------------------+  |
|  | SWITCH PLATFORM ADDRESSING ENGINE                                            |  |
|  | Policy: fixer.addressing = "owner_and_owner_agents"                        |  |
|  | Sender Check: "Harshita" != "Paras (Owner)"                                  |  |
|  +------------------------------------------------------------------------------+  |
|     |                                                                              |
|     v [BLOCKS MESSAGE FROM REACHING AGENT CODE]                                    |
|                                                                                    |
|  Switch Platform (on behalf of Fixer):                                             |
|  "I only take instructions from my owner..."                                       |
+------------------------------------------------------------------------------------+
```

---

## Technical Data Contract & Live Validation Findings

### Data Contract Rules engine

The Watcher agent evaluates raw feed payloads against a 12-rule contract derived from production data validation frameworks (Breck et al., MLSys 2019; Schelter et al., PVLDB 2018). Records failing validation are rejected at ingest and stored in a isolated quarantine table within the warehouse.

| Rule Name | Scope | Severity | Evaluation Logic / Rejection Condition | Live Feed Discovery (7 Nov 2026) |
| :--- | :--- | :--- | :--- | :--- |
| `bogus_timestamp` | Station | Degraded | `last_reported` timestamp earlier than May 2013 (Citi Bike launch). | **47 stations** reporting epoch timestamp `86400` (2 Jan 1970). |
| `over_capacity` | Station | Degraded | `bikes_available + docks_available + disabled > capacity + 2`. | **6 to 9 stations** (e.g., 112 combined bikes/docks at a 109-dock site). |
| `silent_station` | Station | Degraded | Installed station failing to report updates for >24 hours. | **27 to 29 stations** silent for 32 to 43 consecutive hours. |
| `future_timestamp` | Station | Degraded | `last_reported` timestamp > current system time. | 0 occurrences. |
| `unknown_station` | Station | Degraded | Station ID absent from static station information feed. | 0 occurrences. |
| `invalid_count` | Station | Degraded | Negative values for available bikes, ebikes, or docks. | 0 occurrences (backed by DB `CHECK` constraints). |
| `ebikes_exceed_bikes`| Station | Degraded | `ebikes_available > total_bikes_available`. | 0 occurrences (backed by DB `CHECK` constraints). |
| `invalid_flag` | Station | Degraded | Boolean flags containing non-boolean values. | 0 occurrences. |
| `duplicate_station` | Feed | Untrusted | Identical station ID appearing multiple times in one pull. | 0 live (validated via fault injection). |
| `feed_stale` | Feed | Untrusted | Feed `last_updated` header > 5 minutes old. | 0 live (validated via fault injection). |
| `volume_drop` | Feed | Untrusted | Total reporting stations drop below 80% of expected baseline.| 0 occurrences. |
| `feed_unreachable` | Feed | Untrusted | HTTP fetch operation fails or returns non-200 status code. | 0 occurrences. |

### Remediation Mechanics & Dry-Run Previews

When an incident is opened, the Fixer generates bounded remediation options. To adhere to human-AI interaction guidelines (Amershi et al., CHI 2019), every proposal calculates a non-destructive dry-run preview prior to sign-off.

```
+------------------------------------------------------------------------------------+
|                         REMEDIATION & SIGN-OFF WORKFLOW                            |
|                                                                                    |
|  1. DETECT (Watcher)                                                                |
|     Finds 47 records with last_reported = 1970-01-02.                              |
|     Quarantines records -> Opens INC-001 in #data-incidents.                       |
|                                                                                    |
|  2. PROPOSE (Fixer)                                                                |
|     Option A (Recommended): Exclude stations from dispatch until timestamp updates. |
|     Preview: "47 stations stay out of dispatch view (22 in Manhattan below 96 St)." |
|     Option B: Admit counts, override timestamp to current ingest time.             |
|                                                                                    |
|  3. DECIDE (Data Owner)                                                            |
|     Paras types: "@fixer approve INC-001"                                          |
|                                                                                    |
|  4. APPLY (Fixer)                                                                  |
|     Writes standing rule to SQLite: bogus_timestamp -> EXCLUDE.                    |
|     Transaction Metadata: approved_by = "Paras", timestamp = NOW().                |
|                                                                                    |
|  5. VERIFY & RECORD (Watcher & Scribe)                                             |
|     Watcher verifies 47/47 records handled on next run -> Closes INC-001.          |
|     Scribe writes postmortem-INC-001 room document.                                |
+------------------------------------------------------------------------------------+
```

---

## Downstream Gating & Trust State Engine

The Dispatch Analyst implements appropriate reliance principles (Lee & See, 2004) by maintaining a strict trust gate. Prior to answering operational questions, the Analyst calculates system trust by evaluating two independent sources: the Watcher's process heartbeat (`ingest_runs`) and the current `#rebalancing-desk` room document (`data-status`).

```
                              +-----------------------+
                              | Ingest Pipeline Run   |
                              +-----------------------+
                                          |
                                          v
                              +-----------------------+
                              |  Watcher Heartbeat    |
                              |  (ingest_runs table)  |
                              +-----------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
                v (Run < 3 min ago)                                 v (No run in >= 3 min)
+-------------------------------+                         +-----------------------+
|  Evaluate data-status Document|                         |     VERDICT STATE     |
+-------------------------------+                         |                       |
                |                                         |       UNTRUSTED       |
        +-------+-------+                                 |  "Silent watcher is a |
        |               |                                 |    failed watcher"    |
        v               v                                 +-----------------------+
  (Active Open    (Station-Level                                    |
   Feed-Level      Incident Open /                                  |
   Incident OR     Signed-Off Fallback                              v
   Expired Rule)   Active <= 30 min)                      +-----------------------+
        |               |                                 |   Dispatch Analyst    |
        v               v                                 |        Action:        |
  +-----------+   +-----------+                           |        REFUSE         |
  | UNTRUSTED |   | CAVEATED  |                           |  "🛑 I won't send a   |
  +-----------+   +-----------+                           |  truck on this data"  |
        |               |                                 +-----------------------+
        v               v                                           ^
  +-----------+   +-----------+                                     |
  |  Refuse   |   | Answer +  |                                     |
  | Dispatch  |   | Caveats   |                                     |
  +-----------+   +-----------+                                     |
        ^               ^                                           |
        |               |                                           |
        +---------------+-------------------------------------------+
                                (TRUSTED State:
                         No Incidents -> Answer + Citations)
```

### Trust State Matrix

| System Verdict | Operational Condition | Analyst Output Protocol |
| :--- | :--- | :--- |
| **Untrusted** | • Watcher heartbeat silent for $\ge 3$ minutes.<br>• Active, unhandled feed-level incident (`duplicate_station`, `feed_stale`, `volume_drop`).<br>• Active signed-off fallback rule exceeding 30-minute age limit.<br>• Missing `data-status` room document. | **Refuses Dispatch:** Returns explicit error message: *"🛑 I won't send a truck on this data"*, listing precise failure reasons and linking to `#data-incidents`. |
| **Caveated** | • Active station-level incident open (affected stations held out of dispatch).<br>• Active feed-level incident covered by a signed-off temporary fallback rule ($\le 30$ minutes old). | **Executes with Warnings:** Returns station recommendations while explicitly naming all active incidents and stating the count of excluded nearby stations. |
| **Trusted** | • All ingested data passing contract.<br>• Zero open unhandled incidents.<br>• All active station exclusions verified by approved standing rules. | **Executes Normally:** Returns top 5 target stations within 1.2 km requiring rebalancing, with inline data citations `[1]` through `[5]`. |

---

## Important Quotes & Systems Context

> *"Agents can watch the data. People still have to own the decision."*
> — **Context:** Defines the core operational boundary. Machine agents excel at high-frequency monitoring, pattern matching, and draft generation, but legal accountability and operational risk sign-off must remain anchored to a designated human authority.

> *"A fix without a preview is a guess. A fix without a signature is a liability."*
> — **Context:** Establishes the engineering requirements for automated remediation proposals. Agents are forbidden from applying database modifications without generating a deterministic dry-run state showing exact impact metrics, and every applied rule must record the approver's cryptographic identity in the audit trail.

> *"A silent watcher is a failed watcher."*
> — **Context:** Defines pipeline liveness requirements. In observability architectures, the loss of monitoring telemetry must be treated as an immediate system failure. If the Watcher fails to record a heartbeat run for 3 minutes, the Dispatch Analyst automatically downgrades the data verdict to Untrusted, blocking downstream actions regardless of last-known document contents.

> *"Gate the answer, not just the dashboard."*
> — **Context:** Highlights the critical gap in legacy observability tooling. Alerting engineers via passive dashboards or chat channels fails to stop operational damage. Safety rules must gate the downstream API endpoints and AI assistants that drive physical execution.

---

## Strategic & Operational Insights for Engineering Managers

### Key Lessons Learned

1.  **Platform-Enforced Guardrails Over Application Logic:** Implementing security checks within application code creates maintenance risks and potential bypass vectors. Authorization controls belong in infrastructure-level primitives (such as Switch addressing policies) to ensure rules hold across all current and future agents.
2.  **Role-Based Agent Addressing:** Designing agent communication around functional roles (e.g., `@remediator`) rather than specific agent IDs allows teams to swap underlying models or agent implementations without refactoring inter-agent messaging pipelines.
3.  **Room Documents as Inter-Agent Contracts:** Utilizing shared, readable room documents (`data-status`) for state persistence decouples dependent services. The downstream consumer reads state asynchronously, providing transparent, human-auditable system context without introducing tight API coupling.
4.  **Idempotent Connection & State Recovery:** Production chat-ops agents experience network drops and server evictions under high load. Systems must implement connection recovery protocols that preserve connection IDs, resume from event stream cursors, and re-claim operational roles upon reconnect.

### How Signoff compares

| Architecture / Tool Category | Vendor Examples | Strengths | Operational Vulnerability / Gap | Signoff Approach |
| :--- | :--- | :--- | :--- | :--- |
| **Data Observability Platforms** | Monte Carlo, Soda, Anomalo, Bigeye | Excellent defect detection and historical lineage tracking. | Alerts stop at engineering channels; downstream consumers remain un-gated. | Integrates detection directly into chat-ops and gates downstream consumption endpoints. |
| **Enterprise Incident Management** | PagerDuty, incident.io, Rootly | Strong human escalation and on-call scheduling. | Designed for service outages; lacks data remediation previews and data contract integration. | Combines automated data contract previews with human approval gates inside active channels. |
| **Standard Enterprise Chat Assistants** | Slack AI, Copilot | Natural language interface to internal data stores. | Generates answers indiscriminately from available tables without evaluating data health. | Enforces strict trust-state evaluation prior to outputting operational instructions. |

### System Execution Setup

Engineering teams can evaluate and reproduce the Signoff stack locally without external messaging workspace dependencies (such as Slack or Teams) or third-party API keys using the five-command workflow below:

```bash
# 1. Clone the repository
git clone https://github.com/ParasAdlakha/signoff && cd signoff

# 2. Generate local configuration with random secrets
npm run init-env

# 3. Spin up local stack (Switch 0.31.0, Postgres, Mattermost, Gateway)
npm run switch:up

# 4. Bootstrap environment (register 4 agents, apply addressing policies, create linked rooms)
npm run bootstrap

# 5. Launch the four Signoff agents
npm start
```

Once running, access the local dashboard at `http://localhost:8065` to interact with the environment as the data owner.

---

## Theoretical Framework & Research Foundations

Signoff's system design directly operationalizes core principles established across peer-reviewed computer science and human factors literature:

*   **Levels of Automation (Parasuraman, Sheridan & Wickens, IEEE SMC-A 2000):** Signoff operates at Level 5 automation ("The system suggests a decision/action, human approves, system executes"). Automated detection and preview generation are coupled with mandatory human authorization.
*   **Trust in Automation (Lee & See, Human Factors 2004):** Mitigates over-trust and under-trust by dynamically adjusting system transparency (`Untrusted`, `Caveated`, `Trusted`) to ensure operator reliance matches true system capability.
*   **Human-AI Interaction Guidelines (Amershi et al., CHI 2019):** Adheres to G11 ("Make clear why the system did what it did") via detailed dry-run previews and G13 ("Encourage granular feedback") by enabling explicit option selection (`Option A` vs. `Option B`).
*   **Data Validation Protocols (Breck et al., MLSys 2019; Schelter et al., PVLDB 2018):** Enforces declarative schema contracts at ingest, backed by transactional database constraints to prevent corrupted states.
*   **Preventing Data Cascades (Sambasivan et al., CHI 2021):** Halts the downstream propagation of data defects at the ingestion boundary before physical resources are committed.

---

## Acknowledgments & Credits

The authors express gratitude to the hosting organizations, mentors, and open-source teams whose platforms and research made this work possible:

*   **Hackathon Hosts:** WeMakeDevs (Kunal Kushwaha and team) and DevTools Academy for organizing the Flip the Switch Hackathon (4–7 November 2026).
*   **Platform & Infrastructure:** The Switch team at SandboxAQ for developing the open-source Switch agent platform, and Wispr for supporting the event.
*   **Data Sources:** Citi Bike / Lyft and MobilityData for maintaining open access to public General Bikeshare Feed Specification (GBFS) operational feeds.

---

Views are my own.