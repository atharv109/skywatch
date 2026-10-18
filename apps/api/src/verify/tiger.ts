/**
 * Task 7: optional thin Tiger Data layer. When TIGER_DATABASE_URL is set, a
 * check-in is mirrored as one row into the `status_events` Timescale/Postgres
 * table; when it is unset the layer is completely inert (Mongo `verifiedAt`
 * stays the demo source of truth — decision in the task brief: tiger.ts must
 * never become a pipeline dependency).
 *
 * All writes are fire-and-forget: launch, log failures, never block or throw
 * into the route. The only non-imported-pg test surface is buildStatusEvent(),
 * a pure function so the hermetic suite needs no Postgres.
 */
import pg from "pg";
import type { Config } from "../config.ts";
import type { ResourceDoc } from "../types/docs.ts";

export interface TigerStatusEvent {
  resourceId: string;
  resourceName: string;
  status: string;
  capacity: number | null;
  manual: boolean;
  notes: string | null;
  /** GeoJSON order: lon first. */
  lon: number;
  lat: number;
  /** epoch ms of the verification this event mirrors. */
  at: number;
}

/** Pure: map a checked-in resource to the Tiger row shape. null = nothing verified yet. */
export function buildStatusEvent(resource: ResourceDoc): TigerStatusEvent | null {
  if (resource.verifiedAt === null || resource.verifiedAt === undefined) return null;
  const [lon, lat] = resource.loc.coordinates;
  return {
    resourceId: resource.sourceId,
    resourceName: resource.name,
    status: resource.status,
    capacity: resource.capacity ?? null,
    manual: resource.lastCheckin?.manual ?? false,
    notes: resource.lastCheckin?.notes ?? null,
    lon,
    lat,
    at: resource.verifiedAt,
  };
}

/**
 * Fire-and-forget mirror. No-op when TIGER_DATABASE_URL is unset; never throws
 * (a rejected promise is caught inside, a connection error is logged only, and
 * the table is created if missing so the layer is self-sufficient).
 */
export function forwardStatusEvents(
  config: Pick<Config, "tigerDatabaseUrl">,
  events: TigerStatusEvent[],
): void {
  const url = config.tigerDatabaseUrl;
  if (!url || events.length === 0) return;
  (async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS status_events (
           resource_id  text not null,
           resource_name text,
           status       text,
           capacity     integer,
           manual       boolean,
           notes        text,
           lon          double precision,
           lat          double precision,
           observed_at  timestamptz,
           primary key (resource_id, observed_at)
         )`,
      );
      for (const e of events) {
        await client.query(
          `INSERT INTO status_events (resource_id, resource_name, status, capacity, manual, notes, lon, lat, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (resource_id, observed_at) DO NOTHING`,
          [e.resourceId, e.resourceName, e.status, e.capacity, e.manual, e.notes, e.lon, e.lat, new Date(e.at)],
        );
      }
    } finally {
      await client.end();
    }
  })().catch((err) => console.error("tiger status_events mirror failed:", err instanceof Error ? err.message : err));
}

/**
 * Task 8h (READ side — the track's visible artifact): the last N hours of mirrored
 * events for ONE resource. Same one-throwaway-connection pattern as the write
 * side, ordered oldest→newest (chart-ready). Injected as the optional
 * `tigerStatus` dep so the hermetic suite needs no Postgres (the route
 * 503s {configured:false} when the layer is not wired — never faked from Mongo).
 */
export interface TigerStatusRow {
  /** epoch ms of the event (observed_at). */
  at: number;
  status: string;
  manual: boolean;
  notes: string | null;
  capacity: number | null;
}

export function pgStatusHistoryReader(url: string): (entity: string, hours: number, now: number) => Promise<TigerStatusRow[]> {
  return async (entity, hours, now) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const res = (await client.query(
        `SELECT observed_at, status, manual, notes, capacity
           FROM status_events
          WHERE resource_id = $1 AND observed_at >= $2
          ORDER BY observed_at ASC
          LIMIT 500`,
        [entity, new Date(now - hours * 3_600_000)],
      )) as { rows: Array<{ observed_at: Date | string; status: string | null; manual: boolean | null; notes: string | null; capacity: number | null }> };
      return res.rows.map((r) => ({
        at: new Date(r.observed_at).getTime(),
        status: stringOf(r.status) ?? "unknown",
        manual: r.manual === true,
        notes: r.notes ?? null,
        capacity: r.capacity === null || r.capacity === undefined ? null : Number(r.capacity),
      }));
    } finally {
      await client.end();
    }
  };
}

function stringOf(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
}