import { handleRootRelativeAsset } from "../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const response = await handleRootRelativeAsset({
    requestPath: `/${(params.asset ?? []).join("/")}`,
    search: request.nextUrl.search || "",
    referer: request.headers.get("referer") || "",
  });

  return response || new Response("Not found", { status: 404 });
}
