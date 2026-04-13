import { getHealthPayload } from "../../../lib/proxy-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getHealthPayload());
}
