import { NextResponse } from "next/server";

function isPassthroughPath(pathname) {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/a") ||
    pathname.startsWith("/s/") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  );
}

export function proxy(request) {
  const { nextUrl, headers } = request;
  const referer = headers.get("referer");
  let refererUrl = null;

  if (referer) {
    try {
      refererUrl = new URL(referer);
    } catch {}
  }

  if (nextUrl.pathname === "/" && !refererUrl?.pathname.startsWith("/s/")) {
    return NextResponse.next();
  }

  if (isPassthroughPath(nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (!refererUrl) return NextResponse.next();

  try {
    const sessionMatch = refererUrl.pathname.match(/^\/s\/([a-f0-9]+)(\/.*)?$/);
    if (!sessionMatch) return NextResponse.next();

    const sessionId = sessionMatch[1];
    const rewritten = request.nextUrl.clone();
    rewritten.pathname = `/s/${sessionId}${nextUrl.pathname}`;

    if (!rewritten.searchParams.has("__session_url")) {
      const sessionUrl = refererUrl.searchParams.get("__session_url");
      if (sessionUrl) {
        rewritten.searchParams.set("__session_url", sessionUrl);
      }
    }

    return NextResponse.rewrite(rewritten);
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
