// src/routes/api/upload/+server.ts
export async function POST({ request, platform }) {
  const bucket = platform.env.FILES_BUCKET; // R2 binding
  const db = platform.env.DB;               // D1 binding
  // auth check, file upload, metadata write...
  return new Response("Hello!", { status: 200 });
}
