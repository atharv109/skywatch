export class ConfigError extends Error {}

export interface Config {
  mongodbUri: string | null;
  geminiApiKey: string | null;
  airnowApiKey: string | null;
  wsdotAccessCode: string | null;
  perceptronApiKey: string | null;
  photonProjectId: string | null;
  photonProjectSecret: string | null;
  photonWebhookSigningSecret: string | null;
  elevenlabsApiKey: string | null;
  elevenlabsAgentIdBrief: string | null;
  elevenlabsAgentIdCheckin: string | null;
  elevenlabsVoiceWebhookSecret: string | null;
  /** Optional shared secret for /tools/brief endpoints (Task 4); unset = unauthenticated, demo-grade. */
  toolSecret: string | null;
  /** Optional Tiger Data (Timescale Postgres) mirror (Task 7); unset = no Tiger writes. */
  tigerDatabaseUrl: string | null;
  /** Task 8f: Grok Voice TTS (xAI) for the post-call summary audio — unset = text-only path, zero TTS calls. */
  xaiApiKey: string | null;
  /** Task 8e: allow LIVE satellite fetches during gateway sync (default 0 = tests hermetic + offline-deterministic; REPLAY does not gate this). */
  liveSync: boolean;
  publicBaseUrl: string;
  replay: boolean;
  port: number;
}

function secret(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key];
  return value && value.length > 0 ? value : null;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: "${raw}"`);
  }
  return port;
}

function parseReplay(raw: string): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ConfigError(`Invalid REPLAY: "${raw}" (use 0|1)`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    mongodbUri: secret(env, "MONGODB_URI"),
    geminiApiKey: secret(env, "GEMINI_API_KEY"),
    airnowApiKey: secret(env, "AIRNOW_API_KEY"),
    wsdotAccessCode: secret(env, "WSDOT_ACCESS_CODE"),
    perceptronApiKey: secret(env, "PERCEPTRON_API_KEY"),
    photonProjectId: secret(env, "PHOTON_PROJECT_ID"),
    photonProjectSecret: secret(env, "PHOTON_PROJECT_SECRET"),
    photonWebhookSigningSecret: secret(env, "PHOTON_WEBHOOK_SIGNING_SECRET"),
    elevenlabsApiKey: secret(env, "ELEVENLABS_API_KEY"),
    elevenlabsAgentIdBrief: secret(env, "ELEVENLABS_AGENT_ID_BRIEF"),
    elevenlabsAgentIdCheckin: secret(env, "ELEVENLABS_AGENT_ID_CHECKIN"),
    elevenlabsVoiceWebhookSecret: secret(env, "ELEVENLABS_VOICE_WEBHOOK_SECRET"),
    toolSecret: secret(env, "TOOL_SECRET"),
    tigerDatabaseUrl: secret(env, "TIGER_DATABASE_URL"),
    /** Task 8e: allow LIVE satellite fetches during gateway sync (default 0 = tests hermetic + offline-deterministic; REPLAY does not gate this). */
    liveSync: env["SKYWATCH_LIVE_SYNC"] === "1",
    xaiApiKey: secret(env, "XAI_API_KEY"),
    publicBaseUrl: secret(env, "PUBLIC_BASE_URL") ?? `http://localhost:${env["PORT"] ?? "3000"}`,
    replay: parseReplay(env["REPLAY"] ?? "0"),
    port: parsePort(env["PORT"] ?? "3000"),
  };
}