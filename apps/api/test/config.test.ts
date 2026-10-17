import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const empty: Record<string, string | undefined> = {};

describe("loadConfig", () => {
  it("uses defaults for the server fields with no env", () => {
    const config = loadConfig(empty);
    expect(config.port).toBe(3000);
    expect(config.replay).toBe(false);
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.mongodbUri).toBeNull();
  });

  it("exposes every secret as null-or-string from env", () => {
    const config = loadConfig({
      MONGODB_URI: "mongodb://localhost:27017/test",
      GEMINI_API_KEY: "g",
      AIRNOW_API_KEY: "a",
      WSDOT_ACCESS_CODE: "w",
      PERCEPTRON_API_KEY: "p",
      PHOTON_PROJECT_ID: "pid",
      PHOTON_PROJECT_SECRET: "psec",
      PHOTON_WEBHOOK_SIGNING_SECRET: "sig",
      ELEVENLABS_API_KEY: "el",
      ELEVENLABS_AGENT_ID_BRIEF: "eb",
      ELEVENLABS_AGENT_ID_CHECKIN: "ec",
      ELEVENLABS_VOICE_WEBHOOK_SECRET: "vw",
      PUBLIC_BASE_URL: "https://sky.example",
    });
    expect(config.mongodbUri).toBe("mongodb://localhost:27017/test");
    expect(config.geminiApiKey).toBe("g");
    expect(config.airnowApiKey).toBe("a");
    expect(config.wsdotAccessCode).toBe("w");
    expect(config.perceptronApiKey).toBe("p");
    expect(config.photonProjectId).toBe("pid");
    expect(config.photonProjectSecret).toBe("psec");
    expect(config.photonWebhookSigningSecret).toBe("sig");
    expect(config.elevenlabsApiKey).toBe("el");
    expect(config.elevenlabsAgentIdBrief).toBe("eb");
    expect(config.elevenlabsAgentIdCheckin).toBe("ec");
    expect(config.elevenlabsVoiceWebhookSecret).toBe("vw");
    expect(config.publicBaseUrl).toBe("https://sky.example");
  });

  it("parses REPLAY=1", () => {
    expect(loadConfig({ REPLAY: "1" }).replay).toBe(true);
    expect(loadConfig({ REPLAY: "true" }).replay).toBe(true);
    expect(loadConfig({ REPLAY: "0" }).replay).toBe(false);
    expect(loadConfig({ REPLAY: "false" }).replay).toBe(false);
  });

  it("rejects bad REPLAY", () => {
    expect(() => loadConfig({ REPLAY: "yes" })).toThrow(ConfigError);
  });

  it("rejects non-numeric or out-of-range PORT", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(loadConfig({ PORT: "8080" }).port).toBe(8080);
  });
});