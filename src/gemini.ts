import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config, expandHome } from "./config.js";
import type { PoeCallResult } from "./poe.js";

// Direct Google Gemini API (Nano Banana / Imagen), using the caller's own GEMINI_API_KEY.
// Results are returned in the same shape as callPoe so saveOutputs can write them.

export class GeminiError extends Error {}

export interface GeminiImageOptions {
  model: string;
  prompt: string;
  /** Local images to edit or use as reference. */
  referenceImages?: string[];
  aspectRatio?: string;
  /** "1K", "2K" or "4K" (Gemini 3 image models only). */
  imageSize?: string;
  /** Imagen only: how many images to return (1-4). */
  count?: number;
  /** Extra generationConfig (Gemini) or parameters (Imagen) fields. */
  parameters?: Record<string, unknown>;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function requireKey(): string {
  if (!config.gemini.apiKey) {
    throw new GeminiError(
      "GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey and add it to the poe-media server's env in your Claude config, then restart Claude.",
    );
  }
  return config.gemini.apiKey;
}

function explainHttpError(status: number, body: string): string {
  let detail = body.slice(0, 500);
  try {
    detail = JSON.parse(body)?.error?.message ?? detail;
  } catch {
    /* keep raw body */
  }
  switch (status) {
    case 400:
      return `Gemini rejected the request (400): ${detail}`;
    case 401:
    case 403:
      return `Gemini rejected the API key (${status}). Check GEMINI_API_KEY and that the Generative Language API is enabled for it. ${detail}`;
    case 404:
      return `Gemini does not know that model (404). Use list_gemini_models to find the exact name. ${detail}`;
    case 429:
      return `Gemini quota or rate limit hit (429). Image models need billing enabled on the key's Google Cloud project. ${detail}`;
    default:
      return `Gemini API error ${status}: ${detail}`;
  }
}

async function post(url: string, body: unknown): Promise<any> {
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": requireKey(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  let res: Response;
  try {
    res = await send();
    // Gemini returns occasional 500/503 "overloaded" errors; one retry after a short pause usually clears them.
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, config.retryDelayMs));
      res = await send();
    }
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new GeminiError(`Gemini did not answer within ${Math.round(config.timeoutMs / 1000)}s.`);
    }
    throw new GeminiError(`Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new GeminiError(explainHttpError(res.status, raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw new GeminiError(`Gemini returned a non-JSON response: ${raw.slice(0, 300)}`);
  }
}

async function imagePart(filePath: string): Promise<{ mimeType: string; data: string }> {
  const resolved = path.resolve(expandHome(filePath));
  const mimeType = IMAGE_MIME[path.extname(resolved).toLowerCase()];
  if (!mimeType) throw new GeminiError(`Not a supported image type (png, jpg, webp, heic): ${resolved}`);
  const buf = await fs.readFile(resolved).catch(() => {
    throw new GeminiError(`Could not read reference image: ${resolved}`);
  });
  return { mimeType, data: buf.toString("base64") };
}

function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** Nano Banana family (gemini-*-image*): generateContent with IMAGE output. */
async function generateWithGemini(opts: GeminiImageOptions): Promise<PoeCallResult> {
  const parts: unknown[] = [{ text: opts.prompt }];
  for (const file of opts.referenceImages ?? []) parts.push({ inlineData: await imagePart(file) });
  const imageConfig = definedOnly({ aspectRatio: opts.aspectRatio, imageSize: opts.imageSize });
  const generationConfig = {
    responseModalities: ["TEXT", "IMAGE"],
    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    ...(opts.parameters ?? {}),
  };
  const json = await post(`${config.gemini.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent`, {
    contents: [{ role: "user", parts }],
    generationConfig,
  });

  const block = json?.promptFeedback?.blockReason;
  if (block) throw new GeminiError(`Gemini blocked the prompt (${block}). Rephrase and try again.`);
  const candidate = json?.candidates?.[0];
  const texts: string[] = [];
  const dataUrls: string[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part?.thought) continue; // Gemini 3 "thinking" drafts, not the final image
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline?.data) dataUrls.push(`data:${inline.mimeType ?? inline.mime_type ?? "image/png"};base64,${inline.data}`);
    else if (typeof part?.text === "string") texts.push(part.text);
  }
  let note: string | undefined;
  if (!dataUrls.length && candidate?.finishReason && candidate.finishReason !== "STOP") {
    note = `Gemini stopped without an image (finishReason ${candidate.finishReason}).`;
  }
  return { text: texts.join("\n"), urls: [], dataUrls, note };
}

/** Imagen family (imagen-*): predict endpoint, text-to-image only. */
async function generateWithImagen(opts: GeminiImageOptions): Promise<PoeCallResult> {
  if (opts.referenceImages?.length) {
    throw new GeminiError("Imagen models on the Gemini API are text-to-image only. Use a gemini-*-image model to edit pictures.");
  }
  const parameters = definedOnly({
    sampleCount: opts.count ?? 1,
    aspectRatio: opts.aspectRatio,
    imageSize: opts.imageSize,
    ...(opts.parameters ?? {}),
  });
  const json = await post(`${config.gemini.baseUrl}/models/${encodeURIComponent(opts.model)}:predict`, {
    instances: [{ prompt: opts.prompt }],
    parameters,
  });
  const dataUrls: string[] = [];
  const reasons: string[] = [];
  for (const p of json?.predictions ?? []) {
    if (p?.bytesBase64Encoded) dataUrls.push(`data:${p.mimeType ?? "image/png"};base64,${p.bytesBase64Encoded}`);
    else if (p?.raiFilteredReason) reasons.push(p.raiFilteredReason);
  }
  return { text: reasons.join("\n"), urls: [], dataUrls, note: reasons.length ? "Some images were filtered by Imagen's safety checks." : undefined };
}

export function generateGeminiImage(opts: GeminiImageOptions): Promise<PoeCallResult> {
  return /^imagen/i.test(opts.model) ? generateWithImagen(opts) : generateWithGemini(opts);
}

export async function listGeminiModels(): Promise<Array<{ id: string; description?: string; methods: string[] }>> {
  const key = requireKey();
  const models: Array<{ id: string; description?: string; methods: string[] }> = [];
  let pageToken = "";
  do {
    const url = `${config.gemini.baseUrl}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(60_000) });
    const raw = await res.text();
    if (!res.ok) throw new GeminiError(explainHttpError(res.status, raw));
    const json = JSON.parse(raw);
    for (const m of json?.models ?? []) {
      models.push({
        id: String(m.name ?? "").replace(/^models\//, ""),
        description: m.displayName ?? m.description,
        methods: m.supportedGenerationMethods ?? [],
      });
    }
    pageToken = json?.nextPageToken ?? "";
  } while (pageToken);
  return models;
}
