#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { generateGeminiImage, listGeminiModels } from "./gemini.js";
import { callPoe, listModels, saveOutputs, type MediaKind, type PoeCallResult } from "./poe.js";

const server = new McpServer({ name: "poe-media", version: "1.1.0" });

// Shared optional inputs for every generation tool.
const common = {
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Extra bot-specific parameters sent with the request (Poe's extra_body), e.g. {\"aspect_ratio\": \"16:9\"}. Names differ per bot; see the bot's page at poe.com/<bot>/api.",
    ),
  prompt_flags: z
    .string()
    .optional()
    .describe(
      "Poe-style flags appended to the prompt, e.g. \"--aspect 16:9 --duration 8\". Use when a bot ignores `parameters`.",
    ),
  output_dir: z.string().optional().describe(`Folder to save files in. Defaults to ${config.outputDir}`),
};

interface RunArgs {
  kind: MediaKind;
  /** Runs the request instead of Poe (used by the Gemini tool). Flags are not applied. */
  call?: () => Promise<PoeCallResult>;
  /** Shown in messages, e.g. 'Poe bot "GPT-Image-2"'. */
  label?: string;
  model: string;
  prompt: string;
  attachments?: string[];
  /** Convenience options (aspect ratio, duration, voice). Sent as Poe prompt flags, which bots honor more reliably than API parameters. */
  flags?: { aspect?: string; duration?: number; voice?: string };
  parameters?: Record<string, unknown>;
  prompt_flags?: string;
  output_dir?: string;
}

function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// GPT-Image-1 (and -Mini) only render 1:1, 3:2 and 2:3, so snap any requested ratio to the nearest of those.
function snapAspectForGptImage(aspect: string): string {
  const m = aspect.match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return aspect;
  const r = Number(m[1]) / Number(m[2]);
  if (r > 1.2) return "3:2";
  if (r < 1 / 1.2) return "2:3";
  return "1:1";
}

function buildFlags(model: string, flags: RunArgs["flags"]): { text: string; note?: string } {
  const parts: string[] = [];
  let note: string | undefined;
  if (flags?.aspect) {
    let aspect = flags.aspect.trim();
    if (/gpt-image-1/i.test(model)) {
      const snapped = snapAspectForGptImage(aspect);
      if (snapped !== aspect) note = `${model} only supports 1:1, 3:2 and 2:3, so ${aspect} was sent as ${snapped}.`;
      aspect = snapped;
    }
    parts.push(`--aspect ${aspect}`);
  }
  if (flags?.duration) parts.push(`--duration ${flags.duration}`);
  if (flags?.voice) parts.push(`--voice ${flags.voice}`);
  return { text: parts.join(" "), note };
}

async function generate(args: RunArgs): Promise<CallToolResult> {
  try {
    const label = args.label ?? `Poe bot "${args.model}"`;
    const built: { text: string; note?: string } = args.call ? { text: "" } : buildFlags(args.model, args.flags);
    const prompt = [args.prompt, built.text, args.prompt_flags].filter(Boolean).join(" ");
    const parameters = definedOnly(args.parameters ?? {});
    const result = args.call
      ? await args.call()
      : await callPoe({
          model: args.model,
          prompt,
          attachments: args.attachments,
          parameters: Object.keys(parameters).length ? parameters : undefined,
        });
    const { files, links, errors } = await saveOutputs(result, args.kind, args.prompt, args.output_dir);

    const lines: string[] = [];
    if (files.length) {
      lines.push(`Generated with ${label}. Saved ${files.length} file(s):`);
      for (const f of files) {
        lines.push(`- ${f.path} (${f.mimeType}, ${(f.bytes / 1024).toFixed(0)} KB)${f.url ? `\n  source: ${f.url}` : ""}`);
      }
    } else {
      lines.push(`${label} answered but returned no image or media.`);
    }
    for (const note of [built.note, result.note]) if (note) lines.push("", `Note: ${note}`);
    if (links.length) lines.push("", "Other links in the reply:", ...links.map((l) => `- ${l}`));
    if (errors.length) lines.push("", "Problems:", ...errors.map((e) => `- ${e}`));
    const botText = result.text.trim();
    if (botText) lines.push("", "Model reply:", botText.length > 2000 ? `${botText.slice(0, 2000)}…` : botText);

    const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    for (const f of files) {
      if (f.mimeType.startsWith("image/") && f.bytes <= config.inlineImageMaxBytes) {
        const data = (await fs.readFile(f.path)).toString("base64");
        content.push({ type: "image", data, mimeType: f.mimeType });
      }
    }
    return { content, isError: files.length === 0 && links.length === 0 };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

// Slow generations (video, GPT-Image models) can outlast the client's request timeout. Each one runs as a
// background job: the tool waits up to POE_SYNC_WAIT_MS, then hands back a job id to collect later.
interface Job {
  id: string;
  model: string;
  startedAt: number;
  promise: Promise<CallToolResult>;
  result?: CallToolResult;
}
const jobs = new Map<string, Job>();

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: any) => Promise<void>;
};

async function waitForJob(job: Job, extra: Extra): Promise<CallToolResult> {
  const token = extra._meta?.progressToken;
  const ticker =
    token === undefined
      ? undefined
      : setInterval(() => {
          const secs = Math.round((Date.now() - job.startedAt) / 1000);
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: secs, message: `Waiting for ${job.model} (${secs}s)` },
            })
            .catch(() => {});
        }, 5000);
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), config.syncWaitMs)));
    const done = await Promise.race([job.promise, timeout]).finally(() => clearTimeout(timer));
    if (done) {
      jobs.delete(job.id);
      return done;
    }
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return {
      content: [
        {
          type: "text",
          text: `${job.model} is still working after ${secs}s. The file will be saved when it finishes. Call get_generation_result with job_id "${job.id}" to collect it (wait a little between checks).`,
        },
      ],
    };
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

function run(args: RunArgs, extra: Extra): Promise<CallToolResult> {
  const job: Job = { id: randomUUID().slice(0, 8), model: args.model, startedAt: Date.now(), promise: generate(args) };
  job.promise.then((r) => (job.result = r));
  jobs.set(job.id, job);
  return waitForJob(job, extra);
}

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description: `Generate an image from a text prompt with a Poe image bot (default: ${config.models.image}; others include Seedream-4.0, GPT-Image-1, FLUX-pro-1.1-ultra, Imagen-4-Ultra, Ideogram-v3, Nano-Banana). Pass reference_images to edit or remix existing pictures. Files are saved locally and their paths returned. Slow bots return a job_id; collect it with get_generation_result.`,
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw"),
      model: z.string().optional().describe("Poe bot name, e.g. GPT-Image-2, Seedream-4.0, Imagen-4-Ultra, FLUX-pro-1.1-ultra"),
      aspect_ratio: z.string().optional().describe("e.g. 1:1, 16:9, 9:16, 4:3"),
      reference_images: z.array(z.string()).optional().describe("Local image paths to edit or use as reference"),
      ...common,
    },
  },
  async (a, extra) =>
    run({
      kind: "image",
      model: a.model ?? config.models.image,
      prompt: a.prompt,
      attachments: a.reference_images,
      flags: { aspect: a.aspect_ratio },
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }, extra),
);

server.registerTool(
  "generate_video",
  {
    title: "Generate video",
    description: `Generate a video clip from a text prompt with a Poe video bot (default: ${config.models.video}; others include Sora-2, Kling-2.1-Master, Runway-Gen-4-Turbo, Hailuo-02, Veo-3-Fast). Optionally animate a start image. Video can take several minutes.`,
    inputSchema: {
      prompt: z.string().min(1).describe("Describe the scene, motion, camera and sound"),
      model: z.string().optional().describe("Poe bot name, e.g. Veo-3, Sora-2, Kling-2.1-Master"),
      aspect_ratio: z.string().optional().describe("e.g. 16:9 or 9:16"),
      duration_seconds: z.number().int().positive().optional().describe("Clip length, if the bot supports it"),
      start_image: z.string().optional().describe("Local image path to animate (image-to-video)"),
      ...common,
    },
  },
  async (a, extra) =>
    run({
      kind: "video",
      model: a.model ?? config.models.video,
      prompt: a.prompt,
      attachments: a.start_image ? [a.start_image] : undefined,
      flags: { aspect: a.aspect_ratio, duration: a.duration_seconds },
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }, extra),
);

server.registerTool(
  "generate_speech",
  {
    title: "Generate speech",
    description: `Turn text into spoken audio with a Poe text-to-speech bot (default: ${config.models.speech}; others include ElevenLabs-v3, Hailuo-Speech-02, OpenAI TTS bots). Saves an audio file locally.`,
    inputSchema: {
      text: z.string().min(1).describe("The words to speak"),
      model: z.string().optional().describe("Poe bot name, e.g. ElevenLabs, ElevenLabs-v3"),
      voice: z.string().optional().describe("Voice name, if the bot supports choosing one"),
      ...common,
    },
  },
  async (a, extra) =>
    run({
      kind: "audio",
      model: a.model ?? config.models.speech,
      prompt: a.text,
      flags: { voice: a.voice },
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }, extra),
);

server.registerTool(
  "generate_music",
  {
    title: "Generate music",
    description: `Compose music or sound from a text prompt with a Poe music bot (default: ${config.models.music}; others include ElevenLabs-Music, Stable-Audio-2.5, MiniMax music bots). Describe genre, mood, tempo and instruments.`,
    inputSchema: {
      prompt: z.string().min(1).describe("Genre, mood, tempo, instruments, lyrics if supported"),
      model: z.string().optional().describe("Poe bot name, e.g. Lyria, ElevenLabs-Music"),
      duration_seconds: z.number().int().positive().optional().describe("Track length, if the bot supports it"),
      ...common,
    },
  },
  async (a, extra) =>
    run({
      kind: "music",
      model: a.model ?? config.models.music,
      prompt: a.prompt,
      flags: { duration: a.duration_seconds },
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }, extra),
);

server.registerTool(
  "generate_with_poe_bot",
  {
    title: "Run any Poe media bot",
    description:
      "Call any Poe bot by name with a prompt and optional local file attachments, then download whatever media it returns. Use for bots the dedicated tools don't cover (upscalers, lip-sync, sound effects, background removal...).",
    inputSchema: {
      model: z.string().min(1).describe("Exact Poe bot name"),
      prompt: z.string().min(1),
      attachments: z.array(z.string()).optional().describe("Local file paths to send with the prompt"),
      ...common,
    },
  },
  async (a, extra) =>
    run({
      kind: "media",
      model: a.model,
      prompt: a.prompt,
      attachments: a.attachments,
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }, extra),
);

server.registerTool(
  "generate_image_gemini",
  {
    title: "Generate image with Gemini",
    description: `Generate or edit an image directly through the Google Gemini API with your own key (default: ${config.gemini.imageModel}, i.e. Nano Banana Pro; also gemini-3.1-flash-image (Nano Banana 2) for cheaper drafts, or imagen-4.0-ultra-generate-001 for text-to-image only). Pass reference_images (local paths) to edit pictures or keep a character consistent. Files are saved locally. Slow runs return a job_id; collect it with get_generation_result.`,
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw, or what to change in the reference images"),
      model: z.string().optional().describe("Gemini model id, e.g. gemini-3-pro-image, gemini-3.1-flash-image, imagen-4.0-ultra-generate-001"),
      aspect_ratio: z.string().optional().describe("1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9 or 21:9"),
      image_size: z.enum(["1K", "2K", "4K"]).optional().describe("Output resolution (Gemini 3 image models and Imagen). 4K costs more"),
      reference_images: z.array(z.string()).optional().describe("Local image paths to edit or use as reference (Gemini models only, up to 14)"),
      count: z.number().int().min(1).max(4).optional().describe("Imagen only: number of images"),
      parameters: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Extra fields merged into Gemini's generationConfig (or Imagen's parameters)"),
      output_dir: common.output_dir,
    },
  },
  async (a, extra) => {
    const model = a.model ?? config.gemini.imageModel;
    return run({
      kind: "image",
      model,
      label: `Gemini model "${model}"`,
      prompt: a.prompt,
      output_dir: a.output_dir,
      call: () =>
        generateGeminiImage({
          model,
          prompt: a.prompt,
          referenceImages: a.reference_images,
          aspectRatio: a.aspect_ratio,
          imageSize: a.image_size,
          count: a.count,
          parameters: a.parameters,
        }),
    }, extra);
  },
);

server.registerTool(
  "list_gemini_models",
  {
    title: "List Gemini models",
    description: "List model ids available to your Gemini API key, filtered to image models by default (search e.g. 'image', 'imagen', 'flash').",
    inputSchema: {
      search: z.string().optional().describe("Case-insensitive filter on id/name. Defaults to image models"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search }): Promise<CallToolResult> => {
    try {
      const models = await listGeminiModels();
      const term = search?.toLowerCase();
      const rows = models
        .filter((m) => {
          const hay = `${m.id} ${m.description ?? ""}`.toLowerCase();
          return term ? hay.includes(term) : /image|imagen/.test(hay);
        })
        .map((m) => `- ${m.id}${m.description ? ` — ${m.description}` : ""} [${m.methods.join(", ")}]`);
      return {
        content: [{ type: "text", text: rows.length ? `${rows.length} model(s):\n${rows.join("\n")}` : "No models matched." }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  },
);

server.registerTool(
  "get_generation_result",
  {
    title: "Get generation result",
    description:
      "Collect the result of a generation that was still running when its tool call returned. Pass the job_id from that message. Waits a while, then returns the saved files or says it is still running.",
    inputSchema: { job_id: z.string().min(1) },
  },
  async ({ job_id }, extra): Promise<CallToolResult> => {
    const job = jobs.get(job_id);
    if (!job) {
      return {
        content: [{ type: "text", text: `No running job "${job_id}". It may already have been collected, or the server restarted.` }],
        isError: true,
      };
    }
    return waitForJob(job, extra);
  },
);

server.registerTool(
  "list_poe_models",
  {
    title: "List Poe models",
    description: "List bot/model names available through the Poe API, optionally filtered by a search term (e.g. 'veo', 'image', 'eleven').",
    inputSchema: {
      search: z.string().optional().describe("Case-insensitive filter on name/description"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search }): Promise<CallToolResult> => {
    try {
      const models = await listModels();
      const term = search?.toLowerCase();
      const rows = models
        .filter((m) => !term || JSON.stringify(m).toLowerCase().includes(term))
        .map((m) => {
          const desc = typeof m.description === "string" ? ` — ${m.description.slice(0, 120)}` : "";
          return `- ${m.id}${desc}`;
        });
      return {
        content: [{ type: "text", text: rows.length ? `${rows.length} model(s):\n${rows.join("\n")}` : "No models matched." }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  },
);

async function main() {
  if (!config.apiKey) console.error("[poe-media] Warning: POE_API_KEY is not set; Poe tool calls will fail until it is.");
  if (!config.gemini.apiKey) console.error("[poe-media] Note: GEMINI_API_KEY is not set; generate_image_gemini is unavailable.");
  await server.connect(new StdioServerTransport());
  console.error(`[poe-media] Ready. Saving outputs to ${config.outputDir}`);
}

main().catch((err) => {
  console.error("[poe-media] Fatal:", err);
  process.exit(1);
});
