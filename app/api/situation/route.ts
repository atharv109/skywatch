import { tick } from "@/lib/simulator";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenario = url.searchParams.get("scenario") === "smoke" ? "smoke" : "flood";
  return Response.json(tick(scenario));
}
