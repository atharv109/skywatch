/**
 * ASK SKYWATCH over the mesh (Task 8d): a msg packet addressed `to: "SKYWATCH"`
 * (case-insensitive) is a question to the responders' node. On sync it is routed
 * to the Task 6 conversational loop (chatReply — the SAME validator rules: no
 * invented entities; the answer carries brief facts + officialSource + 911), with
 * the brief resolved at the ASKER'S coordinates (the question packet carries the
 * stranded user's location — the gateway's lat/lon is only the bundle's broadcast
 * anchor). The answer is NOT sent anywhere: it is stored as a new msg packet from
 * device SKYWATCH-CORE (verify:"core", trusted-core exemption) that flows to the
 * asker through /mesh/state messages and the downlink bundle's normal radius
 * rules.
 *
 * Gemini key semantics (chatReply gates itself, nothing new here):
 *   - GEMINI_API_KEY + REPLAY=0 -> a live tool-loop answer, validated against the
 *     point brief (entity/format violation -> deterministic fallback composition).
 *   - no key or REPLAY=1 -> the deterministic brief-fields composition
 *     (fallbackRender), zero network calls. Identical to the chat.ts fallback.
 */
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { buildUserBrief } from "../brief/build.ts";
import { chatReply } from "../deliver/chat.ts";
import type { UserRecord } from "../deliver/store.ts";
import type { AppStore } from "../store.ts";
import type { SkywatchChat, SkywatchQuestion } from "./types.ts";

/**
 * The Ask-Skywatch chat seam bound to the app's dependencies. `fetcher` is the
 * test seam (chatReply already accepts it) — undefined uses real fetch.
 */
export function makeSkywatchChat(
  config: Config,
  deps: Pick<AppDeps, "match" | "store" | "deliver">,
  fetcher?: typeof fetch,
): SkywatchChat {
  return async (question: SkywatchQuestion, now: number): Promise<string> => {
    const [match, appStore, deliver] = await Promise.all([deps.match(), deps.store(config), deps.deliver()]);
    // The point-brief: the brief builder's per-user flow (buildUserBrief over a
    // match store) with a POINT subject instead of a user — same hazard/shelter/
    // road semantics the /tools/brief route assembles for a byPhone user.
    const lastBrief = await buildUserBrief(match, { id: question.askerHash, lang: "en", loc: question.loc }, now);
    // Synthetic deliver-side user, used ONLY for the loop's history read
    // (recentConversation over a never-registered id returns empty in both
    // stores): the mesh path writes NO conversation rows, NO outbox row and
    // sends nothing. The phone placeholder is never read — chat prompts/tools
    // may not contain a phone number, and nothing here persists it.
    const user: UserRecord = {
      id: `mesh-asker:${question.askerHash}`,
      phone: "+10000000000",
      platform: "sms",
      spaceId: "mesh",
      lang: "en",
      state: "active",
      loc: question.loc,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: now,
      updatedAt: now,
    };
    const outcome = await chatReply({
      config,
      deliver,
      appStore,
      user,
      text: question.text,
      lastBrief,
      ...(fetcher ? { fetcher } : {}),
      now,
    });
    return outcome.reply;
  };
}