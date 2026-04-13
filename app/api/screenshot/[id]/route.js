import { handleScreenshot } from "../../../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const sessionCookie = request.cookies.get(`tr_session_${params.id}`)?.value;
  return handleScreenshot(
    params.id,
    sessionCookie ? decodeURIComponent(sessionCookie) : null,
  );
}
