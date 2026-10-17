# Skywatch

Emergency interface for a hazard watch. Each screen has one job: join, see the situation, act on a brief, or keep going without a network.

People in an emergency have less working memory, shaky hands, and very little patience. The largest type is the next fact. Color is never the only signal. Details stay one deliberate tap away.

This is a design prototype. The incidents, shelters, and phone number are sample data for West Oakland — not a live dispatch.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

## Screens

- `/` — the Photon number. Tap it to copy. Text `hi` to join.
- `/ops` — full-screen map. Layers, marker details, and manual check-in live in bottom sheets.
- `/alert` — the household brief in English, Español, 中文, Tagalog, Tiếng Việt, or العربية. Arabic uses a right-to-left layout.
- `/offline` — local mesh messages, with sync disabled until the phone is online.

Add `?unavailable=1` on the entry screen to see the missing-number state. On the map, Replay switches between the flood and smoke samples. The household brief follows that choice.

The sample number is `510-555-0142`. Nothing is sent.
