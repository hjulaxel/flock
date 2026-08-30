# Proposal — Flock Team: the paid tier

**Status: proposal, 2026-08-18. Nothing in this document is implemented.**
Written after the monetization session of 2026-08-18. Donations and the
premium account features (queued dispatch, cross-provider handoff) are
sibling lanes with their own branches; this document owns the company
model only: what a team pays for, how the license works, what the
codebase needs, and the compliance lines the product must never cross.

---

## 1. What stays free, and why

Everything that exists today stays free: the tree, forks, attention
routing, the accounts section, worktrees, project workspaces, the verbs.
Two reasons, both structural:

- **Adoption is the moat.** A team tier is worthless until individuals
  already run Flock; charging the individual gate-keeps the funnel.
- **The free tier is the compliance story.** Local machine, official
  CLIs, no credential custody. That posture is what makes the paid tier
  sellable at all (§7).

The dividing rule for every future feature:

> **If it helps one person drive their own sessions, it is free.
> If it moves work between people, it is Team.**

Coordination between humans is the one thing an individual install
cannot give itself — that is the product.

## 2. What Team contains

Four pillars, in order of build effort.

### 2.1 Shared session visibility — "the team flock"

Teammates see each other's project trees: session names, status dots,
ages, lineage edges. **Names and shape, never transcripts.** Opt-in per
project. The sidebar already renders exactly this viewmodel for one
machine; what is new is exporting roster deltas and rendering a
teammate's tree read-only under their name.

### 2.2 Handoff and artifact sharing

**Close with summary** already produces the right artifact — a
human-written brief at the moment a line of work ends. Team makes that
brief durable and addressed: a handoff lands in the team channel (§3)
and shows up in the recipient's sidebar; the recipient resumes **on
their own seat** — their account, their CLI. When sender and recipient
run different CLIs, the brief is the interface; a transcript is never
pretended across CLI or across humans. (Cross-provider mechanics for
*one* person belong to the accounts lane; this pillar reuses whatever
brief format that lane lands on.)

### 2.2b The artifact layer: an index, not a host

Research note, 2026-08-18: both vendors now ship artifact sharing of
their own. Claude artifacts gained public links and multiplayer
editing in Claude Code on 2026-07-13 — on Pro/Max a public link is
the only way to share; on Team/Enterprise access is granted to named
people or the whole org, viewers sign in on their own org seat, and
public links stay off until an org Owner enables them. ChatGPT has
shared projects (invite-only or anyone-with-link) and collaborative
canvas/writing surfaces with comments and version history. Codex
output is git-native — a branch or a PR.

So the *content* problem is solved by the vendors, on their access
control, seat by seat. What no vendor gives a team is one place to
find all of it across providers, tied to the work it came from. That
gap is exactly Flock-shaped: the artifact layer is an **index in the
hub, not a host**.

- An artifact entry is a pointer: title, provider, URL or repo path,
  author seat, and — the part only Flock can know — the session, and
  so the lineage, it came from.
- Three classes: files in the repository (a path at a commit; git
  already moves those), provider-hosted pages (claude.ai artifact
  links, ChatGPT shared-project and canvas links), and hub-native
  briefs (§2.2).
- Viewing follows the vendor's own access control, which enforces
  §7.1 for free: an org-scoped claude.ai artifact demands the
  viewer's own org seat. And for one person with several accounts,
  the entry names its provider, so Flock can open it under the right
  identity row.
- Public links are badged loudly. Public claude.ai share links have
  already been Google-indexed in the wild (July 2026), so the
  registry records visibility, the UI marks public entries, and
  org-scoped links are the recommended default.

The hub never re-hosts vendor content — pointers and briefs only — so
custody, retention and revocation stay with the vendor and with the
seat that created the artifact.

### 2.3 Per-seat setup

A team template: settings defaults, skills, project definitions, and
account *slots* — "this team runs a work Claude plan and a Codex plan"
as names and types. Onboarding a new machine is clone-and-apply instead
of an afternoon of clicking. The template ships the shape of the setup,
**never auth material** (§7.2).

### 2.4 Support contracts

Named contact, onboarding call, response target. Sold separately from
seats (§6) — also the natural home for "help us roll Flock and CLI
accounts out across the org" consulting.

## 3. Transport: the team's own remote

There is no Flock server. A team designates a private git repository —
**the hub** — and Flock pushes and pulls small append-only files
(roster deltas, handoff briefs, the team template) through the git
binary, behind a new setting, off by default.

This is the same carve-out shape the privacy page already has: today
the only network in the product is `gh pr list`, opt-in behind
`lineage.git.pullRequests`. Team sync becomes the second entry in that
table — `git fetch/push <hub>`, opt-in behind `lineage.team.remote`.
The documented claim that **there is no HTTP client anywhere in the
extension** stays true: git is the transport, and the destination is
the customer's own infrastructure. **Team data goes to the team's
remote, never to us.** That sentence is a selling point against every
hosted dashboard in this space, and it is also why GDPR exposure stays
minimal: we never process the customer's data.

Mechanics kept deliberately dumb: files keyed by (seat, node id),
append-only, so merges are unions and conflicts cannot happen by
construction. Honest limits: no live presence — visibility advances on
fetch, and minutes-scale latency is fine for a sidebar whose attention
dot is minutes-scale anyway.

## 4. Licensing: offline keys, sold through a merchant of record

Two constraints decide almost everything:

1. **The privacy promise.** A license check that phones home would
   break a documented guarantee (`docs/reference.md`, Privacy). Not
   acceptable, not even once at activation.
2. **A VSIX unpacks to readable JavaScript.** Any gate can be patched
   out by a motivated user. Licensing here is a statement of terms,
   not DRM — the Sublime Text posture. We optimize for honest teams
   with budgets, not against determined individuals.

Therefore: **offline-verifiable license keys.** A key is a payload
(edition, seat count, expiry, licensee) plus an ed25519 signature; the
public key ships in the extension; verification is `node:crypto`, no
dependency, no network. Subscriptions work as keys that carry expiry
plus a grace window — renewal delivers a fresh key. For teams the key
is a file in the hub repo, so every seat picks up a renewal with no
per-machine ceremony: per-seat setup (§2.3) doing double duty.

### Who sells the key

| Option | What it is | Where it stands (checked 2026-08-18) |
| --- | --- | --- |
| **Polar** | Merchant of record, developer-native, license-key benefit built in | Free tier now 5% + 50¢ per transaction (was 4% + 40¢ before May 2026; lower rates behind a monthly platform fee). Its license keys validate against *their API* — network — so we use Polar for checkout, tax, and subscription lifecycle only. |
| **Lemon Squeezy** | Merchant of record, license API with activation limits | Stripe-owned since July 2024, being folded into Stripe Managed Payments (public preview Feb 2026); 5% + 50¢ plus add-ons; onboarding and roadmap visibly uncertain. Wrong time to build on it. |
| **Keygen** | Licensing infrastructure, not payments — flat fee, never a revenue cut; ed25519-signed keys and offline verification are its normal mode; CE is free and self-hostable | Solves a problem we solve with ~100 lines (a signer), and sells nothing — a merchant is still needed. Adopt later if issuance outgrows the webhook script. |

**Recommendation: Polar checkout + keys we sign ourselves.** A Polar
webhook drives a tiny issuer — a service *we* run, outside the
extension — that signs and emails the key. Merchant of record matters
concretely for a Swedish seller: Polar owes and remits EU VAT, we
never touch it. And because keys verify against our public key, not
Polar's API, switching merchants later strands no customer.

## 5. What the codebase needs

Small, and almost entirely additive:

- **`src/entitlements.ts`** — parse and verify a key (ed25519 via
  `node:crypto`, public key as a constant), expose
  `entitled('team')` and a current-license descriptor for display.
- **Storage** — VS Code `SecretStorage`, not settings: a license is
  not configuration. Two commands: **Flock: Enter License Key…** and
  **Flock: Remove License**.
- **Gating pattern** — Team features are new surface, so they gate at
  registration, exactly the way `lineage.*` booleans already decide
  what exists today. No entitlement checks threaded through free code
  paths: the free tier must not grow conditionals.
- **Display** — one quiet row in the accounts section (edition,
  expiry). No license changes nothing that exists; nothing nags.
- **Docs** — the privacy page gains the hub carve-out line beside the
  `gh` one; `docs/settings.md` gains `lineage.team.*`.
- **Build** — no obfuscation (constraint 2 makes it theater); esbuild
  output unchanged.
- **Tests** — verify valid / expired / tampered / wrong-key, storage
  round-trip, gates default-off. All offline, in the existing vitest
  suite.

## 6. Pricing shape

A shape, not final numbers:

- **Free** — everything that exists today, forever.
- **Team** — per seat per month, billed annually at launch (one
  billing state to support instead of three): **~€10/seat/mo,
  minimum 3 seats.** A team whose members each carry €20–200/mo in AI
  plans is not price-sensitive at €10 for the coordination layer.
- **Support contract** — flat annual add-on, ~€1,500/yr shape: named
  contact, onboarding, response target.
- **Individual Pro** — deliberately not priced here. If the accounts
  lane ships gateable features, Pro slots in under Team later; free
  users lose nothing they have today.

The VS Code Marketplace has no billing, so the listing stays free and
the license is external — which is the normal pattern for paid
extensions and costs nothing in compliance.

## 7. The compliance boundary

Product invariants, not legal advice. They exist because both vendors'
consumer terms forbid sharing an account or making it available to
anyone else, and 2026 enforcement (the OAuth-in-third-party-tools
bans) showed the perimeter is patrolled. The paid tier survives by
being unambiguously on the right side:

1. **Every human, their own seat.** Flock Team coordinates seats; it
   never multiplies them. Nothing in the product may let human B
   drive human A's account.
2. **No credential custody.** Nothing auth-shaped crosses machines:
   no OAuth tokens, no API keys, no account config directories — an
   account's profile dir contains live credentials, so the per-seat
   template (§2.3) carries names and types, never contents.
3. **Artifacts travel; accounts don't.** A handoff is a brief. The
   resume happens on the recipient's seat, always.
4. **No hosted middleman.** The hub is the customer's remote. We
   never operate a service that sits between a user and their AI
   vendor.
5. **Framing discipline.** Sell "never lose your place" and "see your
   team's work" — never "more quota", never "share a plan".

## 8. What this proposal does not propose

- No hosted Flock service, in any tier.
- No transcript sync — summaries only. Transcripts are large,
  private, and CLI-specific; briefs are small, written for a reader,
  and portable.
- No re-hosting of provider artifact content — the hub carries
  pointers and briefs (§2.2b), never copies of vendor-hosted pages.
- No DRM, no obfuscation, no activation servers.
- No commitment to an individual Pro tier (the accounts lane owns
  that question).
- No change to anything the free tier does today.

---

Licensing facts above were checked 2026-08-18:
[Polar pricing change](https://fungies.io/polar-sh-review-2026/) ·
[Polar benefits](https://polar.sh/features/benefits) ·
[Polar as merchant of record](https://polar.sh/docs/merchant-of-record/introduction) ·
[Stripe acquires Lemon Squeezy](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy) ·
[Lemon Squeezy in 2026](https://fungies.io/lemon-squeezy-stripe-acquisition-saas-founders-2026/) ·
[Keygen pricing](https://keygen.sh/pricing/) ·
[Keygen offline cryptography](https://keygen.sh/docs/api/cryptography/)

Artifact-layer facts (§2.2b), same date:
[Claude Code artifacts docs](https://code.claude.com/docs/en/artifacts) ·
[Claude artifacts public sharing and multiplayer](https://stacktr.ee/blog/claude-artifacts-public-sharing) ·
[Shared claude.ai links indexed by Google](https://venturebeat.com/technology/uh-oh-some-claude-shared-conversations-and-artifacts-appear-to-be-indexed-and-publicly-accessible-on-google-search) ·
[ChatGPT shared projects](https://www.aioperator.com/blog/chatgpt-project-sharing-a-new-feature-that-improves-team-collaboration/) ·
[ChatGPT canvas collaboration](https://worldofaihub.com/ai-news/openai-expands-chatgpt-canvas-real-time-collaboration/)
