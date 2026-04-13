import { handleSessionProxy } from "../../../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const slug = params.slug ?? [];
  const subPath = slug.length ? `/${slug.join("/")}` : "/";
  return handleSessionProxy({
    id: params.id,
    subPath,
    search: request.nextUrl.search || "",
    accept: request.headers.get("accept") || "",
  });
}
