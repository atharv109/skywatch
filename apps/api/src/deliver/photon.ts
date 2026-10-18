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

/**
 * The REAL spectrum-ts surface (verified live 2026-10-18 against the installed
 * package, node 24): the metapackage's MAIN export carries `Spectrum` etc. but NOT
 * the `imessage` provider — that lives on the SUBPATH "spectrum-ts/providers/imessage"
 * (with the `.config()` builder + a platform-instance selector called ON the Spectrum
 * app: `im = imessage(app)`). Send path (the contract from
 * skywatch-notes/photon-interface.md, verified in the typings):
 *
 *     const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
 *     const im = imessage(app);
 *     const user = await im.user(senderId);            // (for space.create)
 *     const space = await im.space.get(spaceId);        // resolve by persisted id
 *     await space.send(text);                           // ContentInput overload
 */
export interface SpectrumSdk {
  Spectrum: (input: AnyRecord) => Promise<SpectrumApp>;
  /** The iMessage provider: config() builder + (app) → PlatformInstance selector (call signature per the real platform type). */
  imessage: {
    config(): AnyRecord;
    (app: SpectrumApp): AnyRecord;
    [key: string]: any;
  };
}

/**
 * The shape check against reality: exactly what toPhoton needs. A mismatch is a
 * REAL integration bug (not "not wired") — it must surface as "failed" in the
 * outbox, never as the not_wired "credentials missing" story.
 */
export function spectrumShapeOk(mod: { Spectrum?: unknown; imessage?: unknown } | null): mod is SpectrumSdk {
  return (
    typeof mod?.Spectrum === "function" &&
    typeof mod.imessage === "function" &&
    typeof (mod.imessage as { config?: unknown }).config === "function"
  );
}

let sdkCache: SpectrumSdk | "unavailable" | null = null;

/**
 * Load the REAL SDK (main export + the providers/imessage subpath) and shape-check.
 * Any failure → null; toPhoton re-labels that as SpectrumLoadError ("failed") when
 * creds ARE set — the SDK is installed, so a load failure is a bug, not missing wiring.
 */
export async function loadSpectrumSdk(): Promise<SpectrumSdk | null> {
  if (sdkCache === "unavailable") return null;
  if (sdkCache) return sdkCache;
  try {
    const core = (await import("spectrum-ts")) as AnyRecord;
    const imessageProvider = (await import("spectrum-ts/providers/imessage")) as AnyRecord;
    const candidate = { Spectrum: core["Spectrum"], imessage: imessageProvider["imessage"] };
    if (!spectrumShapeOk(candidate)) throw new Error("unexpected spectrum-ts export shape");
    sdkCache = candidate;
    return sdkCache;
  } catch {
    sdkCache = "unavailable";
    return null;
  }
}

export type PhotonOutboundCredentials = Pick<Config, "photonProjectId" | "photonProjectSecret">;

/**
 * Thrown when the SDK is installed (creds set) but cannot LOAD (missing package
 * pieces/shape mismatch): a real integration bug — send.ts records it as "failed"
 * so the outbox shows it, INSTEAD of the not_wired "creds unset" row.
 */
export class SpectrumLoadError extends Error {}

/**
 * Send text into a Photon space (photon-interface.md), on the verified REAL API:
 * Spectrum() cloud auth (projectId + projectSecret) → the imessage platform
 * instance → space.get(spaceId) (the persisted id, e.g. "any;-;+1555…") →
 * space.send(text).
 *
 * NOT_WIRED boundaries: unset creds → NotWiredError BEFORE any network call
 * (the only not_wired case). SDK load/shape failure WITH creds set →
 * SpectrumLoadError → the outbox row says "failed" (visible integration bug).
 * Runtime SDK errors after load (e.g. SpectrumCloudError) are NOT NotWiredError —
 * callers write "failed".
 */
export async function toPhoton(
  spaceId: string,
  text: string,
  credentials: PhotonOutboundCredentials,
  /** Test seam: defaults to the real loadSpectrumSdk (memoized). */
  loader: () => Promise<SpectrumSdk | null> = loadSpectrumSdk,
): Promise<void> {
  if (!credentials.photonProjectId || !credentials.photonProjectSecret) {
    throw new NotWiredError(
      "not wired: PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET are unset — this outbound was recorded in the outbox as not_wired, nothing sent",
    );
  }
  const sdk = await loader();
  if (!sdk) {
    throw new SpectrumLoadError(
      "spectrum-ts SDK failed to load or shape mismatched (package installed; check node_modules/spectrum-ts) — this outbound was recorded in the outbox as failed, nothing sent",
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