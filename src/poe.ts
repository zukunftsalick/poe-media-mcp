import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config, expandHome } from "./config.js";

export type MediaKind = "image" | "video" | "audio" | "music" | "media";

export interface PoeCallOptions {
  model: string;
  prompt: string;
  /** Local files (images, audio, video) sent along with the prompt, e.g. for image editing or image-to-video. */
  attachments?: string[];
  /** Extra bot parameters, sent as top-level request fields (what the OpenAI SDK calls extra_body). */
  parameters?: Record<string, unknown>;
}

export interface PoeCallResult {
  text: string;
  urls: string[];
  dataUrls: string[];
  /** Set when the request had to be adjusted to succeed. */
  note?: string;
}

export interface SavedFile {
  path: string;
  url?: string;
  mimeType: string;
  bytes: number;
}

export class PoeError extends Error {}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
};

const DEFAULT_EXT: Record<MediaKind, string> = {
  image: ".png",
  video: ".mp4",
  audio: ".mp3",
  music: ".mp3",
  media: ".bin",
};

function requireKey(): string {
  if (!config.apiKey) {
    throw new PoeError(
      "POE_API_KEY is not set. Get a key at https://poe.com/api_key and add it to the server's env in your Claude config.",
    );
  }
  return config.apiKey;
}

async function fileToDataUrl(filePath: string): Promise<{ dataUrl: string; mimeType: string; name: string }> {
  const resolved = path.resolve(expandHome(filePath));
  const buf = await fs.readFile(resolved).catch(() => {
    throw new PoeError(`Could not read attachment: ${resolved}`);
  });
  const mimeType = MIME_BY_EXT[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  return { dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType, name: path.basename(resolved) };
}

async function buildMessageContent(prompt: string, attachments: string[] | undefined) {
  if (!attachments?.length) return prompt;
  const parts: unknown[] = [{ type: "text", text: prompt }];
  for (const file of attachments) {
    const { dataUrl, mimeType, name } = await fileToDataUrl(file);
    if (mimeType.startsWith("image/")) {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    } else {
      parts.push({ type: "file", file: { filename: name, file_data: dataUrl } });
    }
  }
  return parts;
}

function explainHttpError(status: number, body: string): string {
  const detail = body.slice(0, 500);
  switch (status) {
    case 401:
      return `Poe rejected the API key (401). Check POE_API_KEY. ${detail}`;
    case 402:
      return `Not enough Poe points for this request (402). Top up at https://poe.com. ${detail}`;
    case 404:
      return `Poe does not know that bot/model (404). Use list_poe_models to find the exact name. ${detail}`;
    case 429:
      return `Poe rate limit hit (429). Wait a bit and try again. ${detail}`;
    default:
      return `Poe API error ${status}: ${detail}`;
  }
}

/** Collects every http(s) URL found anywhere in a JSON value (covers attachment-style fields). */
function collectUrlsDeep(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^https?:\/\/\S+$/.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectUrlsDeep(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectUrlsDeep(v, out);
  }
}

export function extractUrls(text: string): { urls: string[]; dataUrls: string[] } {
  const urls = new Set<string>();
  // Markdown links/images: [alt](url) or ![alt](url "title")
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (/^https?:\/\//.test(m[1])) urls.add(m[1]);
  }
  // Bare URLs
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'\]]+/g)) {
    urls.add(m[0].replace(/[.,;:!?*_`]+$/, ""));
  }
  const dataUrls = [...text.matchAll(/data:(?:image|video|audio)\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
  return { urls: [...urls], dataUrls };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

/** Turns bot parameters into Poe chat-style flags, e.g. {aspect_ratio: "16:9"} -> "--aspect 16:9". */
export function parametersToFlags(parameters: Record<string, unknown>): string {
  const rename: Record<string, string> = { aspect_ratio: "aspect" };
  return Object.entries(parameters)
    .map(([k, v]) => `--${rename[k] ?? k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

async function postCompletion(body: unknown): Promise<{ ok: boolean; status: number; raw: string }> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    return { ok: res.ok, status: res.status, raw: await res.text() };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new PoeError(
        `Poe did not answer within ${Math.round(config.timeoutMs / 1000)}s. Video can be slow; raise POE_TIMEOUT_MS if needed.`,
      );
    }
    throw new PoeError(`Could not reach Poe: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function callPoe(opts: PoeCallOptions): Promise<PoeCallResult> {
  requireKey();
  const parameters = opts.parameters ?? {};
  const request = async (prompt: string, extra: Record<string, unknown>) =>
    postCompletion({
      ...extra,
      model: opts.model,
      stream: false, // Poe recommends non-streaming for media bots
      messages: [{ role: "user", content: await buildMessageContent(prompt, opts.attachments) }],
    });

  let note: string | undefined;
  let res = await request(opts.prompt, parameters);
  // Poe's upstream providers return occasional 5xx errors; one retry after a short pause usually clears them.
  if (res.status >= 500) {
    await new Promise((r) => setTimeout(r, config.retryDelayMs));
    res = await request(opts.prompt, parameters);
  }
  // Many bots reject custom parameters over the OpenAI-compatible API (often as a 400
  // "upstream gateway failure"). Retry once with the parameters written as prompt flags.
  if (!res.ok && res.status === 400 && Object.keys(parameters).length) {
    const flags = parametersToFlags(parameters);
    const retry = await request(`${opts.prompt} ${flags}`, {});
    if (retry.ok) note = `The bot rejected the parameters, so they were sent as prompt flags instead: ${flags}`;
    res = retry;
  }
  if (!res.ok) throw new PoeError(explainHttpError(res.status, res.raw));

  let json: any;
  try {
    json = JSON.parse(res.raw);
  } catch {
    throw new PoeError(`Poe returned a non-JSON response: ${res.raw.slice(0, 300)}`);
  }

  const message = json?.choices?.[0]?.message ?? {};
  const text = contentToText(message.content);
  const { urls, dataUrls } = extractUrls(text);
  const all = new Set(urls);
  const { content: _ignored, ...rest } = message;
  collectUrlsDeep(rest, all);
  return { text, urls: [...all], dataUrls, note };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "output"
  );
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function extFor(mimeType: string, url: string | undefined, kind: MediaKind): string {
  const fromMime = EXT_BY_MIME[mimeType];
  if (fromMime) return fromMime;
  if (url) {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      if (ext && MIME_BY_EXT[ext]) return ext;
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_EXT[kind];
}

function isMediaMime(mime: string): boolean {
  return /^(image|video|audio)\//.test(mime) || mime === "application/octet-stream";
}

/**
 * Downloads every media URL from a Poe response into outputDir.
 * Non-media links (HTML pages etc.) are skipped and returned in `links`.
 */
export async function saveOutputs(
  result: PoeCallResult,
  kind: MediaKind,
  prompt: string,
  outputDir?: string,
): Promise<{ files: SavedFile[]; links: string[]; errors: string[] }> {
  const dir = path.resolve(expandHome(outputDir ?? config.outputDir));
  await fs.mkdir(dir, { recursive: true });
  const base = `${stamp()}_${kind}_${slugify(prompt)}`;
  const files: SavedFile[] = [];
  const links: string[] = [];
  const errors: string[] = [];
  let index = 0;

  const write = async (buf: Buffer, mimeType: string, url?: string) => {
    // Never overwrite an earlier file (two calls with the same prompt in the same second share a base name).
    let file: string;
    for (;;) {
      index += 1;
      file = path.join(dir, `${base}${index > 1 ? `_${index}` : ""}${extFor(mimeType, url, kind)}`);
      try {
        await fs.writeFile(file, buf, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    files.push({ path: file, url, mimeType, bytes: buf.length });
  };

  for (const dataUrl of result.dataUrls) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (m) await write(Buffer.from(m[2], "base64"), m[1]);
  }

  // Only fetch https links (plain http is allowed only when POE_BASE_URL itself is http, i.e. local testing).
  const allowHttp = config.baseUrl.startsWith("http:");
  for (const url of result.urls) {
    if (!url.startsWith("https:") && !allowHttp) {
      links.push(url);
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
      if (!res.ok) {
        errors.push(`Download failed (${res.status}) for ${url}`);
        continue;
      }
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (mime && !isMediaMime(mime)) {
        links.push(url);
        await res.body?.cancel();
        continue;
      }
      await write(Buffer.from(await res.arrayBuffer()), mime || "application/octet-stream", url);
    } catch (err) {
      errors.push(`Download failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { files, links, errors };
}

export async function listModels(): Promise<Array<{ id: string; [k: string]: unknown }>> {
  const key = requireKey();
  const res = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new PoeError(explainHttpError(res.status, raw));
  const json = JSON.parse(raw);
  return Array.isArray(json?.data) ? json.data : [];
}
