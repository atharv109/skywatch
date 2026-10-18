import { apiOrigin } from "@/lib/upstream";
import { peek, takeDropTicket, tick } from "@/lib/simulator";
import type { ScenarioId } from "@/lib/types";

/** SSE pipe of the backend's own frame stream (`event: state`, re-broadcast every 5 s). */
function streamUpstream(): Promise<Response> {
  return fetch(`${apiOrigin()}/map/stream`, { cache: "no-store" }).then((response) => {
    if (!response.ok || !response.body) {
      return Response.json({ error: "The situation stream is down." }, { status: 503 });
    }
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}

/** The in-process fallback simulator, kept behind ?sim=1 for API-down demos. */
function streamSimulator(scenario: ScenarioId): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        send(peek(scenario));
      } catch {
        return;
      }

      timer = setInterval(() => {
        ticks += 1;
        try {
          send(tick(scenario));
        } catch {
          if (timer) clearInterval(timer);
          return;
        }
        if (ticks >= 2 && takeDropTicket()) {
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            /* The client already left. */
          }
        }
      }, 8000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("sim") === "1") {
    return streamSimulator(url.searchParams.get("scenario") === "smoke" ? "smoke" : "flood");
  }
  try {
    return await streamUpstream();
  } catch {
    return Response.json({ error: "The situation stream is down." }, { status: 503 });
  }
}