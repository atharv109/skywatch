# skywatch
Backend for Skywatch — DubHacks '26. Public hazard data -> one household, one language, one verified shelter.

Env vars live in root `.env.example`. Note on `TOOL_SECRET`: when it is unset, the tool endpoints (`/tools/*`, `/verify/run`, `/roads/check`) accept **unauthenticated writes** — that is a demo-grade decision, the boot log warns about it, and it must be set before the API is exposed.
