import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as File;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const filename = `chirp_${Date.now()}.wav`;

  const blob = await put(filename, file, {
    access: "public",
  });

  return NextResponse.json({
    url: blob.url,
    downloadUrl: blob.downloadUrl,
  });
}
