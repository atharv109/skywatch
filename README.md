# Skywatch

Emergency interface for a hazard watch. Each screen has one job: join, see the situation, act on a brief, or keep going without a network.

The live path follows the gateway around Seattle. `?sim=1` keeps the local West Oakland flood and smoke replay.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The dev server listens on port 4317.

Set `SKYWATCH_API` to the gateway origin. The default is `https://skywatch-9kvd.onrender.com`. A local gateway can be `http://127.0.0.1:3000`.

Set `NEXT_PUBLIC_DEMO_SIGNUP=1` to show “Watch the demo signup” on the brief. That button asks this app to sign a demo webhook. It does not collect a phone number. `SKYWATCH_WEBHOOK_SECRET` overrides the demo signing secret.

## Screens

- `/` — join. Text hi from your own phone, then open the brief.
- `/ops` — full-screen map. The live map fits the Seattle hazards and shelters. Layers, marker details, and manual check-in live in the bottom sheet.
- `/alert` — the household brief. The live brief comes from the gateway and follows its language. `?sim=1` uses the saved Oakland flood or smoke sample.
- `/offline` — neighbor broadcast and direct messages, photo reports, and the last satellite overlay.

`?sim=1` stays on for the browser tab. Use a new tab to return to the live gateway.

## Location

“Use my location” stores latitude, longitude, and accuracy on this phone. The map recenters, the shelter distance is measured from you, and mesh packets carry those coordinates. If location is off, distances say they are from a sample home in Seattle.
