---
name: analyze-x-account
description: Use when a Claude session has a scraped output/<handle>.json and needs to produce a rigorous personality / content-strategy dossier. Runs a multi-agent Opus workflow — 12+ analyst personas read the corpora in parallel, an adversarial critic catches gaps, a synthesis pass merges them, and a final agent renders an interactive HTML dossier with charts. Covers local enrichment, the like-rate (not raw-views) insight, the analyst roster, and the HTML spec.
---

# ANALYSIS_USAGE — multi-agent dossier on an X account

You are a Claude session with a completed scrape (`output/<handle>.json`, from
**`SCRAPE_USAGE.md`**). Your job is a sharp, **evidence-based** dossier on the account's
personality, network, and content engine.

> **Why this is a workflow, not one prompt.** A single LLM pass over the corpus *flattens* it —
> one generalist read collapses copywriting, tribal dynamics, persuasion mechanics, and network
> strategy into mush. Instead you fan out **12+ specialist Opus subagents in parallel**, each
> wearing one analytical "personality," then critique, synthesize, and render. Different lenses
> on the same tweets surface insights no single pass will.

**Pipeline:** `enrich (local code)` → **`12+ lenses ∥`** → `adversarial critique` →
`synthesis` → **`HTML render`**.

> **Security:** everything under `analysis/` is **gitignored** — it names a real person and is
> derived personal analysis. Never commit it; never paste it into a commit/PR/issue.

---

## 1. Step 0 — enrich locally (unchanged, cheap)

```bash
pnpm enrich <handle>     # output/<handle>.json -> analysis/<handle>/
```

`src/enrich.ts` does the structural work in plain code so the agents spend judgment, not
parsing: self-QRT **thread-stitching**, **mention extraction**, **engagement tiering by
like-rate**, a `hasPlug` flag, and the reply/quote/mention graphs + topic + cadence aggregates.

| Artifact | What it is | Fed to |
|---|---|---|
| `stats.md` | Quantified fingerprint (tiers, orbit graphs, topics, cadence) | every lens + synthesis |
| `corpus_resonated.txt` | Top like-rate posts (≥1k views) — **what works** | every lens |
| `corpus_ignored.txt` | High reach, low like-rate — **what flops** | every lens |
| `corpus_replies.txt` | Replies + targets — interaction style | every lens |
| `corpus_qrts.txt` | Quotes as `parent → take`, self-threads flagged | every lens |
| `corpus_voice.txt` | Sample of the default register | every lens |
| `enriched.json` | Every row + derived fields | **chart computation** in render step |

**Every lens reads all six corpora.** They total ~100–150K tokens — each subagent has plenty
of context to read the whole thing, so don't shard the corpus across lenses; shard the
*perspective*.

---

## 2. The load-bearing insight every agent must respect: reach ≠ resonance

`(likes × 2) + views` is ~98% views — it just re-ranks by reach. **Reach** (`views`) is an
algorithm signal; **resonance** (`likes ÷ views`, per 1k impressions) is what actually landed.
The enrichment tiers on like-rate for exactly this reason. **Put this rule in every agent
prompt** — the most revealing finding is usually the *gap* between top-reach and top-resonance
posts. Bake it into the shared preamble (`CORPORA` constant below).

---

## 3. Run it with the Workflow tool (preferred)

Following this skill **is** your opt-in to multi-agent orchestration — call the `Workflow`
tool. Concurrency is capped at ~min(16, cores−2), so 12 lenses run genuinely in parallel.
Agents need to inherit the session model, don't set them an inferior model.

> **Set the handle as a literal — don't trust `args`.** Hardcode `H` to the scraped handle in
> the script. The `args` global has been observed arriving `undefined` for inline scripts, which
> silently rewrites every corpus path to `analysis/undefined/…` and analyzes nothing. The guard
> in the snippet below fails the run fast if the handle is unset, so it never proceeds blind.

```js
export const meta = {
  name: 'creator-dossier',
  description: 'Multi-perspective Opus analysis of a scraped X account -> interactive HTML dossier',
  phases: [
    { title: 'Lenses',     detail: '12 analyst personas read the corpora in parallel' },
    { title: 'Critique',   detail: 'adversarial pass: what did every lens miss or overclaim?' },
    { title: 'Synthesize', detail: 'merge lenses + critique into one model + a chart spec' },
    { title: 'Render',     detail: 'final agent writes self-contained DOSSIER.html with charts' },
  ],
}

// HANDLE — hardcode the scraped handle as a STRING LITERAL. Do NOT depend on the `args`
// global being populated: for inline scripts it can arrive `undefined`, which silently turns
// every path into `analysis/undefined/...` and runs the whole pipeline on nothing. The guard
// converts that silent corruption into a loud, immediate failure before any agent spawns.
const H = (typeof args !== 'undefined' && args && args.handle) || 'PUT_HANDLE_HERE'
if (!H || H === 'PUT_HANDLE_HERE' || String(H).includes('undefined')) {
  throw new Error('Set H to the scraped handle before launching — args.handle was empty.')
}
const DIR = `analysis/${H}`
const CORPORA = `Read these files first: ${DIR}/stats.md, ${DIR}/corpus_resonated.txt, `
  + `${DIR}/corpus_ignored.txt, ${DIR}/corpus_replies.txt, ${DIR}/corpus_qrts.txt, `
  + `${DIR}/corpus_voice.txt.\n`
  + `If any path is missing or contains "undefined", run \`ls analysis/\` and read the single `
  + `<handle> directory present instead — never analyze placeholder or empty paths.\n`
  + `RULE: reason in LIKE-RATE (likes per 1k views = resonance), `
  + `NOT raw views (reach). Cite real posts with their numbers for every claim.`

// Each lens returns this shape (build it as a JSON Schema for opts.schema):
// { lens, thesis, insights:[{claim, evidence:[{quote,url,likes,views,likeRate}], confidence}],
//   signature_pattern, surprises:[], chart_ideas:[] }
const LENS_SCHEMA = { /* ...as above... */ }

phase('Lenses')
const reports = (await parallel(LENSES.map(L => () =>
  agent(`You are ${L.name}. ${L.charter}\n\n${CORPORA}\n\nReturn ONLY your lens's sharpest, `
      + `non-obvious, evidence-cited findings — no generic praise.`,
    { label: `lens:${L.key}`, phase: 'Lenses', schema: LENS_SCHEMA })
))).filter(Boolean)

phase('Critique')
const critique = await agent(
  `You are a skeptical editor. Here are ${reports.length} lens reports:\n${JSON.stringify(reports)}\n`
  + `${CORPORA}\nList: (a) claims that are unsupported or contradicted by the corpora, `
  + `(b) contradictions BETWEEN lenses, (c) what NO lens covered but should have. Be specific.`,
  { phase: 'Critique', schema: CRITIQUE_SCHEMA })

phase('Synthesize')
const model = await agent(
  `Synthesize ONE coherent creator model. Resolve the tensions the critic raised; drop `
  + `unsupported claims; keep only evidence-backed insight.\nLenses:${JSON.stringify(reports)}\n`
  + `Critique:${JSON.stringify(critique)}\n${CORPORA}\n`
  + `Output the dossier sections (see ANALYSIS_USAGE §6) AND a chart spec listing each chart, `
  + `its type, and which enriched.json field(s) feed it.`,
  { phase: 'Synthesize', schema: DOSSIER_SCHEMA })

phase('Render')
await agent(
  `Write a single self-contained file ${DIR}/DOSSIER.html from this synthesis:\n`
  + `${JSON.stringify(model)}\nFollow the HTML spec in ANALYSIS_USAGE §7 exactly. `
  + `To get chart series, WRITE AND RUN a small node script over ${DIR}/enriched.json and `
  + `embed the resulting JSON as a <script>const DATA=...</script> blob — do NOT hand-transcribe `
  + `numbers. Keep every lens as a collapsible appendix. Then report the file path.`,
  { label: 'render:html', phase: 'Render' })

return { lenses: reports.length, out: `${DIR}/DOSSIER.html` }
```

**No-Workflow fallback:** if you're not using the Workflow tool, fan out by issuing all 12
`Agent` calls in a single message (they run concurrently), collect their returns, then one
`Agent` for synthesis, then one `Agent` to render the HTML. Same four phases, manual.

---

## 4. The analyst roster — 12 core lenses (add more freely)

Give each a **strong persona** and a **distinct charter**. The point is divergence: a copywriter
and a psychologist should disagree about why a post worked. Use 12+; the more orthogonal the
lenses, the richer the synthesis.

| Key | Persona | Charter — what it hunts for |
|---|---|---|
| `copywriter` | The Copywriter | Hooks, opening lines, sentence rhythm, word economy, CTA anatomy, what makes a line screenshot-able. Extract the *template* of a winning post from `corpus_resonated`. |
| `marketer` | The Growth Marketer | The funnel & positioning. How attention → action, product-led content loops, offers, the sell-without-selling mechanics. |
| `tribal` | The Tribal Anthropologist | In-group dynamics: slang, shibboleths, shared enemies, status signals, belonging cues, the tribe's myths. Who's inside vs the "other." |
| `psych` | The Behavioral Psychologist | Drives & wounds: what validates them, what they fear, ego structure, emotional register, the needs the posting feeds. |
| `persuasion` | The Persuasion Engineer | Cialdini levers — reciprocity, social proof, scarcity/FOMO, authority, commitment, liking, unity. Tag and quantify which they lean on. |
| `network` | The Network Strategist | The orbit as a power map: alliances, amplification pacts, asymmetric boosts, central nodes, symbiosis loops (reply vs quote vs mention tiers). |
| `brand` | The Brand Strategist | The consistent identity & promise — "the person who…", verbal/visual brand, dilution risks, off-brand moments. |
| `quant` | The Quant | Let numbers talk: reach-vs-resonance, the engagement distribution shape, cadence rhythms, format→like-rate correlations, what the stats debunk. |
| `redteam` | The Red-Team Skeptic | Adversarial. Puncture the flattering story: contradictions, cope, exaggeration, manufactured authenticity, grey-zone tactics, what they hide. |
| `culture` | The Cultural Critic | Zeitgeist surfing: trends/memes/timing, originality vs bandwagon, relationship to the broader wave. |
| `comedian` | The Vibe Analyst | Humor & tone: the "bit," meme fluency, irony, relatability mechanics, how jokes do persuasive work. |
| `ghostwriter` | The Voice Cloner | Capture the idiolect precisely enough to imitate: vocabulary, tics, punctuation, cadence, signature phrases → a reusable "voice spec." |

**Optional extras** (swap in by niche): `operator` (real business signal — traction, moat,
risk, for founders), `storyteller` (the narrative arc / character they play), `salescoach`
(objection handling in replies), `historian` (how they evolved across the window).

---

## 5. Critique → synthesis (the multiple passes)

- **Critique pass** is adversarial on purpose: it kills unsupported claims, surfaces
  contradictions between lenses, and names blind spots no lens covered. This is what turns 12
  hot takes into something trustworthy.
- **Synthesis pass** builds ONE model: resolve tensions, dedupe overlapping insight, keep only
  evidence-backed claims, and decide the narrative spine. It also emits the **chart spec** so
  the render step knows exactly what to visualize and from which field.
- Want even more rigor? Add a second critique loop, or a "completeness critic" that asks *what
  modality/claim is still unverified* and spawns targeted follow-up lenses until it comes back
  dry. Scale passes to how thorough the user asked for.

---

## 6. Dossier content (what synthesis must produce)

The same proven spine — now as structured data the HTML render consumes:

1. **Hero** — who they are + the *single defining stat* (e.g. "median 1 like / 219 views but a
   4,551-like top post → high-frequency, low-average, occasionally-viral").
2. **Personality & Tone Matrix** — register, worldview, the recurring *thesis & foil*, edge.
3. **The Orbit** — network leverage; reply vs quote vs mention tiers; the #1 node & the pattern.
4. **The Playbook** — the repeatable *unit* of their posting (hook → mechanism → CTA), annotated.
5. **Resonates vs. Ignored** — the like-rate contrast, with example galleries of each.
6. **Blind Spots** — misallocated reach, fatigued formats, single-narrative dependency,
   reputational risk, and **what they UNDER-use** (cheapest upside).
7. **Per-lens appendix** — each analyst's raw thesis + top evidence, collapsible.
8. **Method note** — local enrichment, like-rate caveat, and **data-window honesty** (recent ~N
   months, not lifetime — older history is behind the ~3,200 cap).

---

## 7. The HTML dossier spec (the render step)

Output **one self-contained file**: `analysis/<handle>/DOSSIER.html`. Opens by double-click
(`file://`); only external dependency is a charting lib via CDN.

**Data:** the render agent runs a tiny node script over `enriched.json` to compute every chart
series, then embeds it as `<script>const DATA = {...}</script>`. **Never hand-transcribe
numbers** from a 3,000-row file.

**Charts (minimum):**
- **Reach vs Resonance scatter** *(the signature viz)* — x = views (log scale), y = like-rate,
  color by `tier`, hover shows the tweet text + link. Makes the reach≠resonance gap visible.
- **Posting cadence** — posts per week/month (line/bar), optionally overlay mean like-rate.
- **Tier donut** — resonated / ignored / reach / mid counts.
- **Topic fingerprint** — horizontal bar of top content words from `stats.md`.
- **Orbit network** — nodes = accounts, edges = reply/quote/mention (weighted), target centered.
- **Plug-rate over time** — % of posts with `hasPlug` per month.

**Libraries:** Chart.js (CDN) for scatter/line/bar/donut; ECharts or vis-network (CDN) for the
orbit graph. Pick one network lib; keep it simple.

**Layout & interactivity:**
- Sticky section nav; **Hero** with the defining stat up top.
- **Persona matrix** as cards; **Playbook** with an annotated real example.
- **Resonates vs Ignored** as side-by-side quote-card galleries; cards link to the tweet `url`.
- **Orbit** network with hover-to-highlight neighbors.
- **Per-lens appendix** as accordions (one per analyst), collapsed by default.
- Scatter **filterable by tier**; chart tooltips everywhere.

**Aesthetic:** dark "intelligence dossier" theme, a mono accent font, one accent color,
generous typography, responsive. It should feel like a briefing, not a blog post.

**Self-contained caveat:** CDN libs need internet to render. If the user needs fully offline,
inline the lib source into a `<script>` block instead.

---

## 8. Analytical principles (hold the agents to these)

- **Evidence or it didn't happen.** Every claim cites a real post + its numbers. No filler.
- **Separate reach from resonance everywhere.** (§2 — the one rule.)
- **Find the repeated unit.** Identify the signature post *shape*; quote three instances.
- **Map the graph, don't list names.** Reply / quote / mention are different relationship tiers.
- **Name the thesis and the foil** — the one argument they repeat and the thing they define
  against.
- **Make lenses disagree.** If all 12 reports say the same thing, your personas weren't
  distinct enough — sharpen the charters and rerun.
- **Be honest about the window** and the scrape gaps (mangled URLs, no media, inline hashtags).

---

## 9. Checklist

- [ ] `pnpm enrich <handle>` ran; `analysis/<handle>/` populated
- [ ] Handle **hardcoded** in the script (guard present) — confirmed **no `analysis/undefined/`** path in any agent prompt
- [ ] Launched the workflow (or manual fan-out) with **12+ distinct lenses**, all reading all corpora
- [ ] Every agent prompt carried the **like-rate (resonance) rule**
- [ ] Adversarial **critique** pass ran before synthesis
- [ ] **Synthesis** produced one model + a chart spec
- [ ] Render agent computed chart series **from enriched.json via a script** (not by hand)
- [ ] `analysis/<handle>/DOSSIER.html` opens and renders; lenses are collapsible appendices
- [ ] Stated the data window honestly; did **not** commit anything under `analysis/`
