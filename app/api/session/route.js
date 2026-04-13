import { createSession } from "../../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const url = body?.url;
    if (!url) {
      return Response.json({ error: "Missing url" }, { status: 400 });
    }
    try {
      new URL(url);
    } catch {
      return Response.json({ error: "Invalid url" }, { status: 400 });
    }
    return Response.json(createSession(url));
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
