/**
 * Demo-grade packet signature scheme (Task 8 ruling): the device generates an
 * ephemeral Ed25519 keypair in-browser; `sig = Ed25519.sign(msg, privkey)` with
 *
 *     msg = `${id}|${type}|${ts}|${lat}|${lon}|${deviceId}`
 *
 * where each field is stringified with JS `String(v)` on the PARSED packet values
 * (id/type/deviceId as given; ts/lat/lon as JSON numbers — do not reformat them in
 * transit or the sig breaks). Both the sig and the pubkey travel as base64 of the
 * RAW byte forms (32-byte key, 64-byte signature), which is what WebCrypto
 * Ed25519 produces. The backend verifies here (node:crypto) and pins the pubkey on
 * the device's first packet (a `mesh_devices` write; trust-on-first-use, real
 * secret-key auth is impossible for a web app — acknowledged in the plan ruling).
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface SigFields {
  id: string;
  type: string;
  ts: number;
  lat: number;
  lon: number;
  deviceId: string;
}

/** The canonical signed message for a packet (exported: the frontend + tests sign exactly this). */
export function sigMessage(fields: SigFields): string {
  return [fields.id, fields.type, fields.ts, fields.lat, fields.lon, fields.deviceId]
    .map((v) => String(v))
    .join("|");
}

// SPKI DER prefix every 32-byte raw Ed25519 pubkey is wrapped in per RFC 8410.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKey(rawBase64: string) {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) throw new Error("expected a 32-byte raw Ed25519 pubkey");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * true = the signature verifies. All malformed inputs (bad base64, wrong key
 * length, crypto errors) read as false — verification failure NEVER throws.
 */
export function verifySig(sigBase64: string, message: string, pubkeyBase64: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(message, "utf8"),
      ed25519PublicKey(pubkeyBase64),
      Buffer.from(sigBase64, "base64"),
    );
  } catch {
    return false;
  }
}