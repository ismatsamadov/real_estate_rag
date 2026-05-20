/**
 * POST /api/documents/upload-token
 *
 * Mints a short-lived Vercel Blob upload token so the browser can PUT the
 * PDF directly to blob storage, bypassing Vercel's 4.5 MB serverless body
 * limit. The blob URL is then handed to POST /api/documents for indexing,
 * which fetches and deletes the blob — we don't keep PDFs in blob storage.
 *
 * Requires env `BLOB_READ_WRITE_TOKEN` (set automatically by Vercel when a
 * Blob store is linked to the project; for local dev: `vercel env pull`).
 */
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { getUserId } from "../../_auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request): Promise<Response> {
  // Middleware already gates /api/* on the session cookie, so reaching this
  // point implies the request is authenticated.
  getUserId(req);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Large-file upload is not configured on this deployment. " +
          "Either upload a PDF under 4 MB, or set BLOB_READ_WRITE_TOKEN " +
          "(create a Vercel Blob store and link it to this project).",
      },
      { status: 503 },
    );
  }

  const body = (await req.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request: req as unknown as Request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/pdf",
          "application/x-pdf",
          "binary/octet-stream",
        ],
        maximumSizeInBytes: MAX_SIZE_BYTES,
        addRandomSuffix: true,
        // 10 minutes is plenty for a 10 MB PUT and avoids stale tokens
        // sitting in the browser if the user hesitates.
        tokenPayload: JSON.stringify({ issuedAt: Date.now() }),
      }),
      onUploadCompleted: async () => {
        // No-op: the client POSTs to /api/documents itself once the blob is
        // up, so we don't need the post-upload webhook. (It also doesn't
        // fire in local dev.)
      },
    });
    return NextResponse.json(json);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to issue upload token." },
      { status: 400 },
    );
  }
}
