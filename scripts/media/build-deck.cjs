// Builds the Signoff deck: each rendered slide PNG full-bleed, with the spoken script in the notes.
//   node build-deck.cjs <slides png dir> <out.pptx>
const pptxgen = require("pptxgenjs");
const path = require("path");
const [dir, out] = process.argv.slice(2);

const NOTES = [
  "Hi, we're Paras and Harshita. This is Signoff: AI agents catch bad data in the team chat, a person signs off on the fix, and nothing downstream acts on data nobody trusts. Four agents and two people in two Switch rooms, running on the live Citi Bike feed.",
  "A rebalancing dispatcher sends a truck and a crew wherever the station data says. On our first pull of the live Citi Bike feed, 47 stations reported a last update in 1970, 9 reported more bikes than docks, and 27 had been silent for a day. That's normal: data quality issues touch about a third of revenue and take about 15 hours to resolve, data cascades show up in 92% of AI projects, and Gartner expects 40% of agentic AI projects to be cancelled, partly for weak risk controls. The decision to trust or change data needs a named person, in the room, with the evidence.",
  "Two Switch rooms. In data-incidents, the watcher runs our contract every minute and opens one thread per incident. The fixer proposes a remediation, previews exactly what changes, and asks Paras, the data owner, to sign off. Anyone else who tries is refused by Switch. The watcher verifies and closes, and the scribe writes the postmortem. At the rebalancing desk, the analyst reads the room's data-status document before every answer: it refuses, caveats or answers.",
  "Here it is live, on real data. On the left, an incident with its evidence and the fixer's proposal: 47 stations stay out of dispatch, 22 of them in Manhattan, re-admitted automatically, nothing deleted. On the right, Harshita's question gets a caveated answer that names all three open incidents and cites five stations.",
  "Switch isn't a wrapper here. Rooms bridged to Mattermost, exclusive roles for every hand-off, the addressing policy as the sign-off gate, room documents as the shared trust state, threads, links and room instructions. Our four agents speak the agent protocol directly: WebSocket events, HTTP operations. Take Switch away and there's no hand-off, no sign-off and no gate.",
  "The gate belongs to the platform. When Harshita types 'fixer, approve INC-001', Switch answers for the fixer: it only takes instructions from its owner. Every option is a standing rule, previewed first, applied with the approver's name and verified on the next run. And fallbacks are bounded: for a frozen feed, Paras can approve 'answer from the last good data for up to 30 minutes', and after that the analyst refuses again.",
  "Next: two-person sign-off for feed-level incidents and expiry on standing rules, a coding-agent investigator role run by Switch Console, the same rooms in Slack and Teams, and every GBFS system. Signoff: AI agents catch bad data, a person signs off on the fix. Thank you.",
];

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Signoff";
pres.author = "Paras Adlakha and Harshita Adlakha";
pres.company = "Paras Adlakha and Harshita Adlakha";
pres.subject = "Flip the Switch Hackathon, 4-7 November 2026, Track 01";
NOTES.forEach((note, i) => {
  const slide = pres.addSlide();
  slide.addImage({ path: path.join(dir, `s${i + 1}.png`), x: 0, y: 0, w: 10, h: 5.625, altText: `Signoff slide ${i + 1}` });
  slide.addNotes(note);
});
pres.writeFile({ fileName: out }).then((f) => console.log("wrote", f));
