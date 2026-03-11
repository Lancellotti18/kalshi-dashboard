import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

export async function GET() {
  const rawEnv = process.env.KALSHI_PRIVATE_KEY ?? "";
  const keyId  = process.env.KALSHI_API_KEY_ID ?? "(missing)";

  // Try base64 decode
  const decoded = Buffer.from(rawEnv, "base64").toString("utf8").trim();
  const isValidPem = decoded.includes("PRIVATE KEY");
  const firstLine = decoded.split("\n")[0] ?? "";
  const lastLine  = decoded.split("\n").at(-1) ?? "";
  const lineCount = decoded.split("\n").length;

  // Try to sign something to verify key is usable
  let canSign = false;
  try {
    crypto.sign("sha256", Buffer.from("test"), {
      key: decoded,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    canSign = true;
  } catch { /* */ }

  return NextResponse.json({ keyId, isValidPem, firstLine, lastLine, lineCount, canSign, rawEnvLen: rawEnv.length, decodedLen: decoded.length });
}
