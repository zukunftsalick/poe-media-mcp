import * as os from "node:os";
import * as path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  apiKey: process.env.POE_API_KEY?.trim() ?? "",
  baseUrl: (process.env.POE_BASE_URL ?? "https://api.poe.com/v1").replace(/\/+$/, ""),
  outputDir: path.resolve(expandHome(process.env.POE_OUTPUT_DIR ?? "~/poe-media")),
  timeoutMs: envInt("POE_TIMEOUT_MS", 10 * 60 * 1000),
  // How long a tool call waits before handing back a job id (MCP clients time out around 60s).
  retryDelayMs: envInt("POE_RETRY_DELAY_MS", 3000),
  syncWaitMs: envInt("POE_SYNC_WAIT_MS", 45 * 1000),
  // Images up to this size are also returned inline so Claude can look at them.
  inlineImageMaxBytes: envInt("POE_INLINE_IMAGE_MAX_BYTES", 750 * 1024),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? "",
    baseUrl: (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),
    // Nano Banana Pro. Others: gemini-2.5-flash-image (cheaper), imagen-4.0-ultra-generate-001.
    imageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview",
  },
  models: {
    image: process.env.POE_IMAGE_MODEL ?? "GPT-Image-2",
    video: process.env.POE_VIDEO_MODEL ?? "Veo-3",
    speech: process.env.POE_SPEECH_MODEL ?? "ElevenLabs",
    music: process.env.POE_MUSIC_MODEL ?? "Lyria",
  },
};
