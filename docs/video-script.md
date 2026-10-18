# Skywatch video script — 3:00 (record 8:00 AM; backup clips: judge-sim + mesh-sim pages)

Camera: screen recording of the deployed ops board + the app on two/three iPhones. VO recorded clean, cut on beats.

| # | Time | Shot | VO line | Note |
|---|---|---|---|---|
| 1 | 0:00–0:20 | Real Sept 11 2020 NWS AQ alert screenshot, county-wide, English | "September 2020. Seattle's sky is orange. The official alert goes to 2 million people, in English, and doesn't say where to go. Two million people. One message. No shelter. No 'your' language." | static image slide |
| 2 | 0:20–0:40 | Landing page → judge's iPhone: texts "hi" → address → "Español" | "Skywatch asks your neighborhood and your language in two texts. Then it goes quiet until it matters." | judge-sim backup clip if real SMS pending |
| 3 | 0:40–1:00 | Ops board: Replay button press → smoke plume polygons land on the map over the judge's neighborhood | "Tonight we replay a real disaster — the September 2020 smoke event — onto a live map." | the replay click is the beat |
| 4 | 1:00–1:30 | Ops board: 3 teammate phones ring; check-in agent calls shelters; pins flip open/unknown LIVE + "verified 2 min ago" chip | "Skywatch doesn't guess shelters. It calls them. Each answer carries a confidence that fades as it ages — under the threshold, it's 'unknown.' Skywatch would rather say 'I don't know' than send you somewhere closed." | recorded backup clip of pin flip |
| 5 | 1:30–2:10 | Judge's iPhone RINGS — voice call in Spanish + captions: smoke timing, actions, the verified shelter, blocked road from the camera feed; then the follow-up text arrives, judge replies "is the shelter still open?", the answer lands from the call's context | "Your phone rings — in your language: what's happening, what to do, and the one shelter verified open, minutes ago. After the call, a summary with the map link. Ask it anything — it answers only from facts." | live call if Photon's wired by now, else recorded backup |
| 6 | 2:10–2:40 | THE MESH: iPhone status bar "No Service" → app keeps working: Trapped beacon queued, "Ask Skywatch" queued; gateway phone gains a bar — AUTOMATIC sync — dark phone receives bundle: brief in Spanish + "Responders have seen your beacon"; ops board dark-zone lights up | "The towers die. The radios don't. Your phone becomes part of a mesh of neighbors — every phone a relay — and when one of you touches a single bar, the whole mesh gets the news: who's trapped, what's safe, verified, in your language. No button. One bar is enough for everyone." | app demo + harness mesh-sim backup |
| 7 | 2:40–3:00 | SpaceX close: satellite plume overlay arriving in the dark phone's map + the Grok-voice call-recap player on the ops board + endcard (Photon · Grok/xAI · Gemini · Atlas) | "And when even the last bar dies, space still answers: satellite data lands on every dark phone the moment one of you gets signal — spoken back by Grok's voice. Skywatch. When it matters, everyone." | screenshots pre-captured |

Fallbacks, decided in advance:
- If Photon voice isn't wired by 8 AM: shoot step 5 with judge-sim (signed round-trip on the real API) + the scripted-voice screen in the app (reads the same brief) — honest note: "call preview".
- If the live mesh phones are flaky: mesh-sim page is the backup (same backend, real signed packets).
- Keep every clip ≤ 35 s; record VO on a phone in a quiet room; cut at the pin flips.

Recording checklist at 8:00 AM:
- [ ] Ops board + app on phones loaded BEFORE recording; hotspot ON; keep-alive tab open
- [ ] Backup clips: pin-flip (35s), judge-sim text round (30s), mesh-sim sync (30s)
- [ ] Two takes each of 5–6; pick live on the spot; assemble in phone editor; upload by 9:00 AM