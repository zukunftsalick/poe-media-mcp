#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { callPoe, listModels, saveOutputs, type MediaKind } from "./poe.js";

const server = new McpServer({ name: "poe-media", version: "1.0.0" });

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
  model: string;
  prompt: string;
  attachments?: string[];
  parameters?: Record<string, unknown>;
  prompt_flags?: string;
  output_dir?: string;
}

function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

async function run(args: RunArgs): Promise<CallToolResult> {
  try {
    const prompt = args.prompt_flags ? `${args.prompt} ${args.prompt_flags}` : args.prompt;
    const parameters = definedOnly(args.parameters ?? {});
    const result = await callPoe({
      model: args.model,
      prompt,
      attachments: args.attachments,
      parameters: Object.keys(parameters).length ? parameters : undefined,
    });
    const { files, links, errors } = await saveOutputs(result, args.kind, args.prompt, args.output_dir);

    const lines: string[] = [];
    if (files.length) {
      lines.push(`Generated with Poe bot "${args.model}". Saved ${files.length} file(s):`);
      for (const f of files) {
        lines.push(`- ${f.path} (${f.mimeType}, ${(f.bytes / 1024).toFixed(0)} KB)${f.url ? `\n  source: ${f.url}` : ""}`);
      }
    } else {
      lines.push(`Poe bot "${args.model}" answered but returned no downloadable media.`);
    }
    if (links.length) lines.push("", "Other links in the reply:", ...links.map((l) => `- ${l}`));
    if (errors.length) lines.push("", "Problems:", ...errors.map((e) => `- ${e}`));
    const botText = result.text.trim();
    if (botText) lines.push("", "Bot reply:", botText.length > 2000 ? `${botText.slice(0, 2000)}…` : botText);

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

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description: `Generate an image from a text prompt with a Poe image bot (default: ${config.models.image}; others include FLUX-pro-1.1-ultra, Imagen-4-Ultra, Ideogram-v3, Seedream-4.0, Nano-Banana). Pass reference_images to edit or remix existing pictures. Files are saved locally and their paths returned.`,
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw"),
      model: z.string().optional().describe("Poe bot name, e.g. GPT-Image-1, Imagen-4-Ultra, FLUX-pro-1.1-ultra"),
      aspect_ratio: z.string().optional().describe("e.g. 1:1, 16:9, 9:16, 4:3"),
      reference_images: z.array(z.string()).optional().describe("Local image paths to edit or use as reference"),
      ...common,
    },
  },
  async (a) =>
    run({
      kind: "image",
      model: a.model ?? config.models.image,
      prompt: a.prompt,
      attachments: a.reference_images,
      parameters: { aspect_ratio: a.aspect_ratio, ...a.parameters },
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }),
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
  async (a) =>
    run({
      kind: "video",
      model: a.model ?? config.models.video,
      prompt: a.prompt,
      attachments: a.start_image ? [a.start_image] : undefined,
      parameters: { aspect_ratio: a.aspect_ratio, duration: a.duration_seconds, ...a.parameters },
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }),
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
  async (a) =>
    run({
      kind: "audio",
      model: a.model ?? config.models.speech,
      prompt: a.text,
      parameters: { voice: a.voice, ...a.parameters },
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }),
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
  async (a) =>
    run({
      kind: "music",
      model: a.model ?? config.models.music,
      prompt: a.prompt,
      parameters: { duration: a.duration_seconds, ...a.parameters },
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }),
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
  async (a) =>
    run({
      kind: "media",
      model: a.model,
      prompt: a.prompt,
      attachments: a.attachments,
      parameters: a.parameters,
      prompt_flags: a.prompt_flags,
      output_dir: a.output_dir,
    }),
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
  if (!config.apiKey) console.error("[poe-media] Warning: POE_API_KEY is not set; tool calls will fail until it is.");
  await server.connect(new StdioServerTransport());
  console.error(`[poe-media] Ready. Saving outputs to ${config.outputDir}`);
}

main().catch((err) => {
  console.error("[poe-media] Fatal:", err);
  process.exit(1);
});
