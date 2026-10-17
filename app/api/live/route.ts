import { peek, takeDropTicket, tick } from "@/lib/simulator";
import type { ScenarioId } from "@/lib/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenario: ScenarioId = url.searchParams.get("scenario") === "smoke" ? "smoke" : "flood";
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
