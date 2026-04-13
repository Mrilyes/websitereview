import { NextResponse } from "next/server";
import {
  createSession,
  getActiveSessionCookieDescriptor,
  getSessionCookieDescriptor,
} from "../../../lib/proxy-core";

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
    const session = createSession(url);
    const response = NextResponse.json(session);
    const cookie = getSessionCookieDescriptor(session.id, url);
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    const activeCookie = getActiveSessionCookieDescriptor(session.id, url);
    response.cookies.set(
      activeCookie.name,
      activeCookie.value,
      activeCookie.options,
    );
    return response;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
