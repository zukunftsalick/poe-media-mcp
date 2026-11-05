# Poe Media MCP server

A local MCP server that lets Claude (Desktop or Code) generate **images, videos, speech and music** through your **Poe API key**. It follows the same design as Ben Ratcliffe's Segmind MCP server from the Medium article (TypeScript, stdio, one tool per media type, files saved locally), but talks to Poe's OpenAI‑compatible API (`https://api.poe.com/v1`) so you can use any Poe bot: GPT‑Image‑1, Imagen 4, FLUX, Veo 3, Sora 2, Kling, ElevenLabs, Lyria and more.

## Tools

| Tool | What it does | Default bot |
|---|---|---|
| `generate_image` | Text to image. Pass `reference_images` (local paths) to edit or remix pictures | `GPT-Image-2` |
| `generate_video` | Text to video, or animate a `start_image` | `Veo-3` |
| `generate_speech` | Text to speech | `ElevenLabs` |
| `generate_music` | Text to music | `Lyria` |
| `generate_with_poe_bot` | Any Poe bot by name, with optional file attachments | — |
| `get_generation_result` | Collect a slow generation that was still running when its tool call returned | — |
| `list_poe_models` | Look up exact bot names (e.g. search `veo`, `eleven`) | — |

Every generation tool accepts `model` (any Poe bot name), `parameters` (bot‑specific options sent as Poe's `extra_body`, such as `{"aspect_ratio": "16:9"}`), `prompt_flags` (Poe chat‑style flags appended to the prompt, such as `--aspect 16:9`, for bots that ignore `parameters`) and `output_dir`.

Results are downloaded to `~/poe-media` (override with `POE_OUTPUT_DIR`) and the tool returns the file paths plus the original Poe URLs. Images under 750 KB are also shown inline to Claude.

## Install

Requires Node.js 18.17 or newer.

```bash
cd poe-media-mcp
npm install
npm run build
```

That produces `dist/index.js`. Note its absolute path, for example `/Users/you/poe-media-mcp/dist/index.js`.

## Get your Poe API key

Create one at <https://poe.com/api_key>. The key goes in the MCP config's `env` block below; it is never written into the code. Generations spend points from your Poe account.

## Add it to Claude Desktop

Edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "poe-media": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/poe-media-mcp/dist/index.js"],
      "env": {
        "POE_API_KEY": "your-poe-api-key",
        "POE_OUTPUT_DIR": "/Users/you/Pictures/poe-media"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the tools (🔨) menu.

## Add it to Claude Code

```bash
claude mcp add poe-media -s user -e POE_API_KEY=your-poe-api-key -- node /ABSOLUTE/PATH/TO/poe-media-mcp/dist/index.js
```

Check it with `/mcp` inside Claude Code.

## Try it

- "Generate a 16:9 image of a neon Tokyo street in the rain."
- "Make an 8 second vertical video of waves crashing on black sand with Veo-3."
- "Read this intro aloud with ElevenLabs: Welcome to the channel!"
- "Compose a 30 second upbeat lo‑fi track for a product teaser."
- "Use Imagen-4-Ultra to edit ~/Desktop/photo.png so the sky is a sunset."
- "List the Poe models with 'kling' in the name."

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `POE_API_KEY` | (required) | Your Poe API key |
| `POE_OUTPUT_DIR` | `~/poe-media` | Where files are saved |
| `POE_IMAGE_MODEL` | `GPT-Image-2` | Default image bot |
| `POE_VIDEO_MODEL` | `Veo-3` | Default video bot |
| `POE_SPEECH_MODEL` | `ElevenLabs` | Default speech bot |
| `POE_MUSIC_MODEL` | `Lyria` | Default music bot |
| `POE_TIMEOUT_MS` | `600000` | Request timeout (video is slow) |
| `POE_SYNC_WAIT_MS` | `45000` | How long a tool call waits before returning a job id instead |
| `POE_RETRY_DELAY_MS` | `3000` | Pause before retrying a Poe 5xx error once |
| `POE_INLINE_IMAGE_MAX_BYTES` | `768000` | Largest image returned inline to Claude |
| `POE_BASE_URL` | `https://api.poe.com/v1` | API endpoint (for testing) |

## Notes and troubleshooting

- **Bot names are case‑sensitive** and Poe adds new ones often. If a call returns 404, run `list_poe_models` and copy the exact name.
- **Bot options vary.** Poe passes `parameters` straight to the bot, but each bot names its options differently (`aspect_ratio`, `aspect`, `duration`…). The bot's page at `poe.com/<BotName>/api` lists them. If a bot rejects them (often a 400 "upstream gateway failure"), the server automatically retries once with them written as prompt flags (`--aspect 16:9`). If an option is silently ignored, try `prompt_flags` yourself.
- **"Returned no downloadable media"** means the bot replied with text only (for example asking a clarifying question). The bot's reply is included so Claude can adjust and retry.
- **Slow bots and timeouts.** Claude's MCP client gives up on a tool call after about a minute, but video bots and the GPT-Image models often take longer. So each generation runs in the background: if it isn't done after 45 seconds, the tool returns a job id and Claude collects the result with `get_generation_result`. The file is saved either way.
- **Aspect ratio, duration and voice** are sent as Poe prompt flags (`--aspect 16:9`, `--duration 8`, `--voice Rachel`), which bots honor more reliably than API parameters. GPT-Image-1 only supports 1:1, 3:2 and 2:3, so other ratios are snapped to the nearest one there; GPT-Image-2 accepts wider ratios such as 16:9.
- **Poe 500 errors** from upstream providers are retried once automatically. If they persist, try another bot.
- **401** means a bad key, **402** means you're out of Poe points, **429** means rate limited.
- Logs go to stderr (Claude Desktop shows them in its MCP log files); stdout is reserved for the MCP protocol.

## Security and privacy

- Your Poe key lives only in your MCP client config (or a local `.env`, which is git‑ignored). Never commit it.
- Files you pass as `reference_images`, `start_image` or `attachments` are uploaded to Poe and the bot's provider.
- The server only downloads `https` links from Poe's reply; anything else is listed but not fetched.

## Credits

Inspired by Ben Ratcliffe's article [How I built an MCP server that lets Claude generate images, videos, and music on command](https://medium.com/@benratcliffe_/how-i-built-an-mcp-server-that-lets-claude-generate-images-videos-and-music-on-command-a7f596a06a5f) and his [segmind-mcp](https://github.com/bratcliffe909/segmind-mcp). This is an independent implementation for the Poe API, not affiliated with Poe or Quora.

## License

MIT
