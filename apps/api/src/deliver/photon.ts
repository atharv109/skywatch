/**
 * THE single Photon adapter (Global Constraint 6) — Stable "Spectrum" stack per
 * skywatch-notes/photon-interface.md: the documented webhook (Basic-auth
 * projectId/secret, X-Spectrum-* HMAC) + the spectrum-ts SDK as the only send path
 * (the contract is explicit: "there is no public HTTP 'send a message' endpoint
 * today. To reply, run the spectrum-ts SDK ... and call space.send(...).").
 *
 * Un-set creds / not-installed SDK surface as NotWiredError: callers catch it and
 * write an outbox row with status "not_wired", so the whole signup/deliver flow
 * is exercisable end-to-end before Delivery hands over real Photon credentials.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";

export type PhotonPlatform = "imessage" | "sms";

/**
 * Normalized inbound message (Global Constraint 6). `messageId` is the stable
 * dedupe key (photon-interface.md: "stable across retries and across all URLs")
 * — the webhook contract is at-least-once, so the queue id-guards on it.
 */
export interface InboundMessage {
  messageId: string;
  spaceId: string;
  platform: PhotonPlatform;
  text: string;
  senderId: string;
}

/**
 * The documented Stable Spectrum delivery envelope (photon-interface.md
 * "Inbound message webhook", verbatim field names). Loose on-purpose: unknown
 * content arms / events must be ignored ("always keep a default: branch").
 */
export interface PhotonPayload {
  event?: string;
  space?: { id?: string; platform?: string; type?: string; phone?: string } | null;
  message?: {
    id?: string;
    platform?: string;
    direction?: string;
    timestamp?: string;
    sender?: { id?: string; platform?: string } | null;
    space?: { id?: string; platform?: string; type?: string; phone?: string } | null;
    content?: { type?: string; text?: string } | null;
  } | null;
}

/** Thrown by toPhoton when outbound can not actually go out — never kills the pipeline. */
export class NotWiredError extends Error {}

export type VerifyResult =
  | "ok"
  | "bad-signature"
  | "stale-timestamp"
  | "missing-headers"
  | "no-signing-secret";

/** photon-interface.md verification section: reject timestamps older than ~5 minutes. */
export const STALE_AFTER_SECONDS = 300;

/** "iMessage" / "SMS" (+ any casing) → "imessage" | "sms"; anything else → null. */
function normalizePlatform(raw: string | undefined): PhotonPlatform | null {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("imessage")) return "imessage";
  if (lower.includes("sms")) return "sms";
  return null;
}

/**
 * raw → InboundMessage, or null when the payload is not a processable inbound
 * text (other events, non-text content arms: attachment/contact/richlink/
 * reaction/group — the documented default-branch rule).
 */
export function fromPhoton(raw: unknown): InboundMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as PhotonPayload;
  if (payload["event"] !== "messages") return null;
  const message = payload["message"];
  if (!message || message["direction"] !== "inbound") return null;
  const content = message["content"];
  if (!content || content["type"] !== "text" || typeof content["text"] !== "string") return null;

  const platform = normalizePlatform(payload["space"]?.["platform"] ?? message["space"]?.["platform"] ?? message["platform"]);
  // space.id is opaque (iMessage DM "any;-;+<E.164>", chat GUID); sender.id is the
  // handle we key users on. Both are required to reply or track state.
  const spaceId = payload["space"]?.["id"] ?? message["space"]?.["id"];
  const senderId = message["sender"]?.["id"];
  if (!platform || !spaceId || !senderId || !message["id"]) return null;
  return { messageId: message["id"], spaceId, platform, text: content["text"], senderId };
}

/**
 * Verify X-Spectrum-Signature: v0=<hex HMAC-SHA256 over "v0:{timestamp}:{rawBody}">
 * keyed by the webhook signing secret (photon-interface.md "Verification");
 * timingSafeEqual + a 5-minute replay window. `timestamp` is used verbatim from
 * the header so the signed string matches Photon's byte-for-byte.
 */
export function verifyPhotonSignature(args: {
  rawBody: string;
  signature?: string | null;
  timestamp?: string | null;
  secret: string | null;
  /** epoch ms */
  now: number;
}): VerifyResult {
  const { rawBody, signature, timestamp, secret, now } = args;
  if (!secret) return "no-signing-secret"; // fail closed: unverifiable
  if (!signature || !timestamp) return "missing-headers";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || timestamp.length === 0) return "missing-headers"; // malformed header → treat like missing
  if (Math.abs(now / 1000 - ts) > STALE_AFTER_SECONDS) return "stale-timestamp";
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad-signature";
  return "ok";
}

interface SpectrumApp {
  stop(): void;
}
type AnyRecord = Record<string, any>;

let sdkCache: AnyRecord | "unavailable" | null = null;

/**
 * Dynamic (non-literal) specifier: the SDK is not a dependency yet (Delivery owns
 * the real install + cred handoff), so this never resolves today — static
 * resolution would break typecheck. Returns null when it can not be loaded.
 */
async function loadSpectrumSdk(): Promise<AnyRecord | null> {
  if (sdkCache === "unavailable") return null;
  try {
    const spec = "spectrum-ts";
    const mod: AnyRecord = await import(spec);
    if (typeof mod?.Spectrum !== "function" || typeof mod?.imessage !== "function") {
      throw new Error("unexpected spectrum-ts export shape");
    }
    sdkCache = mod;
    return mod;
  } catch {
    sdkCache = "unavailable";
    return null;
  }
}

export type PhotonOutboundCredentials = Pick<Config, "photonProjectId" | "photonProjectSecret">;

/**
 * Send text into a Photon space. Documented stable-SDK send path per
 * photon-interface.md ("Outbound send (text)"): rebuild the space by id, then
 * space.send(text) — `im.space.get("any;-;+15551111111").send(...)` is the
 * spaces-and-users pattern for known ids.
 *
 * NOT_WIRED boundaries (task brief): unset creds → NotWiredError BEFORE any
 * network call; SDK not installed / unexpected export shape → NotWiredError.
 * Runtime SDK errors after load are NOT NotWiredError — callers write the outbox
 * row with status "failed" instead, so a live credential/shape divergence is
 * visible in the outbox rather than silently swallowed.
 */
export async function toPhoton(
  spaceId: string,
  text: string,
  credentials: PhotonOutboundCredentials,
): Promise<void> {
  if (!credentials.photonProjectId || !credentials.photonProjectSecret) {
    throw new NotWiredError(
      "not wired: PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET are unset — this outbound was recorded in the outbox as not_wired, nothing sent",
    );
  }
  const sdk = await loadSpectrumSdk();
  if (!sdk) {
    throw new NotWiredError(
      "not wired: spectrum-ts SDK unavailable (package not installed) — this outbound was recorded in the outbox as not_wired, nothing sent",
    );
  }
  const app: SpectrumApp = await sdk["Spectrum"]({
    projectId: credentials.photonProjectId,
    projectSecret: credentials.photonProjectSecret,
    providers: [sdk["imessage"]["config"]()],
  });
  const im: AnyRecord = sdk["imessage"](app);
  const space: AnyRecord = await im["space"]["get"](spaceId);
  await space["send"](text);
}