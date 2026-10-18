# Devpost draft — Skywatch (DRAFT v1, before 10:30 tonight)

## Title
**Skywatch** — the emergency app that keeps working when the towers don't

## Elevator pitch (2 sentences)
Official alerts go to a whole county, in English, and don't know which shelter is open. Skywatch teaches your household what to do, in your language, over text or a phone call — and when the network dies, the phones around you *become* the network, and one bar of signal anywhere lifts the entire mesh.

## What it does
- **Per-household briefs, in code, not vibes.** Six public data feeds (NWS alerts, NOAA HMS smoke plumes, AirNow, USGS river gauges, WSDOT traffic cameras, FEMA shelters) are matched to *your* exact location. A rule table builds your action list in code; the LLM only rewords the finished brief — and a validator rejects any word, place, or number that isn't in the brief. If the model hallucinates, it falls back to pre-translated templates. Nothing unverified is ever sent.
- **Text + phone, in your language.** Signup is 2 texts (address or ZIP; language: English, Spanish, Mandarin, Tagalog, Vietnamese, Arabic). Deliveries go out by SMS/iMessage (Photon) and as phone calls (ElevenLabs voice over SIP), with a post-call summary text and a conversational follow-up — "is the shelter still open?" — answered only from verified facts.
- **Shelters you can trust.** Partners (shelters, pharmacies) and community centers are check-in-called by voice agents; each verdict carries a confidence that fades with time (30-min half-life shelters, 15-min roads). Confidence < 0.5 = "unknown" — Skywatch *never* recommends a shelter it hasn't verified, and says so honestly when it has none.
- **The offline story (the revolution is software):** towers die → every phone still has radios. Skywatch's mesh mode lets phones relay signed messages phone-to-phone over a Wi-Fi island (WebRTC, no Bluetooth limits, no infrastructure), queue up reports and questions, and the moment *any one node* touches signal — 2G, satellite text, a neighbor's hotspot — it automatically becomes the gateway: everyone's beacon goes up ("responders have seen your beacon"), everyone's brief + verified shelter + blocked roads comes back down, in their language. No button; the status bar narrates it.
- **Ask Skywatch, among the people:** an "is the shelter still open?" chat inside the mesh — answered at *your* coordinates from fact-fenced brief data, even though you're standing in a dark zone.

## Demo
Replays the September 11, 2020 West Coast smoke event (real NOAA archive, converted to a fixture — the demo never depends on Wi-Fi or a live disaster), then: judge signs up by text, gets briefed, their phone *rings* in Spanish (or their language), teammate check-in calls flip shelter pins live on the map, a follow-up text answers the judge's own question — then airplane mode: three phones, two dark, one bar, and the mesh carries the news.

## How we built it
TypeScript + Hono on Node (Render), MongoDB Atlas (geo-queries, 2dsphere), Ed25519-signed mesh packets (WebCrypto TOFU), Photon 2.0 (iMessage + SMS + SIP), ElevenLabs voice agents, Gemini API (wording only, fenced by a validator), Turf-free server-side geo ($geoIntersects/$geoNear), and hand-carved fixtures from every real feed (HMS Sept 2020 KML included). The mesh transport is swap-ready: the same packet+sync contract takes WebRTC today, Meshtastic LoRa ($20/board, 5 km) tomorrow, SMS/satellite as deep fallback.

## Challenges
- Every integration we planned had a dead or changed URL — we verified all nine data sources live and fell back to fixtures-first design before building.
- Photon has two incompatible stacks (Stable vs Beta); we built behind a one-file adapter and the entire pipeline works end-to-end even with sends unwired (fail-visible, never fail-silent).
- The validator was adversarially reviewed: we hardened number/placeholder claims (units, capacity, freshness) until every hallucination class the reviewer could construct either rejected into the safe fallback or was a documented, safe-direction residual.

## Accomplishments
- 194 automated tests green, including against the real MongoDB deployment
- The offline mode is *real*: signed packets, store-and-forward, dedup, priority-ranked rescue clusters that can never be downgraded, explainable scoring with reasons visible on the dashboard
- Live before/after security audit integration (VEYZL): the ungated renderer PR then the gated one, captured on camera
- A deployable pipeline that has briefed real users on the live Render deployment (outbox waits on Photon creds by design, not by accident)

## What we learned / what's next
- Learned: fail-safe beats fail-silent everywhere — every unwired integration records its state instead of pretending.
- Learned: the honest transport story. A stock iPhone has Wi-Fi, Bluetooth, cellular, NFC, GPS — and only one of them is both direct phone-to-phone AND usable from an app. The mesh runs there, hop by hop.
- Next (roadmap): the browser build ships the protocol in final form (signed packets, store-and-forward, dedup, priority rescue clusters, two-way gateway). Peer discovery today stands in via a household hotspot — the demo states it openly. The production app swaps that stand-in for OS-level discovery: Apple's iOS 26 off-grid framework / Android Nearby (native, auto-discovery, no hotspot), a $20 Meshtastic sub-GHz node for mile-scale gaps, and SMS/satellite for deep blackout. Native BLE build is the next 48-hour task; nothing in the protocol changes.

## Built with
JavaScript, TypeScript, Node.js, Hono, MongoDB Atlas, Photon 2.0, ElevenLabs, Gemini, Ed25519/WebCrypto, Leaflet, Next.js (client), Turf/Turf-free geo, NOAA/NWS/USGS/WSDOT/AirNow/FEMA/Census APIs

## Tracks
- **Title: Community Kitchen** — emergency response + equity story (one household in any language when a county alert can't)
- **Photon** — built on Photon 2.0: live iMessage + SMS number; voice via the SMS number over SIP to ElevenLabs
- **SideShift** — who pays: municipalities and county emergency offices (they already mass-mail evacuation info; Skywatch is per-household, verified-shelter outreach in 6 languages) — how it spreads: partner check-ins make every participating nonprofit a node; signups spread by neighbor-to-neighbor mesh, the same channel as the disaster news
- **VEYZL** — real PR audit: before/after validator commits + screenshots in the demo end-card
- **MLH prizes** — Gemini (wording), MongoDB Atlas (records + geo), Tiger Data (status history mirror, env-gated), domain via GoDaddy Registry
```
(Submission checklist: repo linked, video shows call + text follow-up + VEYZL fix, all tracks opt-in, 70%+ code this weekend ✓)