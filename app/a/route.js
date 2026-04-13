import { handleAssetProxy } from "../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const targetUrl = request.nextUrl.searchParams.get("url");
  return handleAssetProxy(targetUrl);
}
