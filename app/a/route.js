import { handleAssetProxy } from "../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const targetUrl = request.nextUrl.searchParams.get("url");
  return handleAssetProxy(targetUrl);
}

async function proxyWithMethod(request, method) {
  const targetUrl = request.nextUrl.searchParams.get("url");
  const body =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  return handleAssetProxy(targetUrl, {
    method,
    body,
    contentType: request.headers.get("content-type") || undefined,
  });
}

export async function POST(request) {
  return proxyWithMethod(request, "POST");
}

export async function PUT(request) {
  return proxyWithMethod(request, "PUT");
}

export async function PATCH(request) {
  return proxyWithMethod(request, "PATCH");
}

export async function DELETE(request) {
  return proxyWithMethod(request, "DELETE");
}
