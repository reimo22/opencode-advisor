import { Plugin } from "@opencode/plugin"
import { readFile } from "fs/promises"
import { join } from "path"

// V2 port of https://github.com/kojoru/opencode-advisor (src/index.ts).
// Ported to the V2 plugin API on 2026-09-16 (ctx.session / ctx.tool domains).
// + local patch: consumes plugin options (model) — not in upstream yet.

const SERVICE = "opencode-advisor"

const ADVISOR_SYSTEM =
  "You are a senior software engineering advisor being consulted by a smaller AI model " +
  "that is actively working on a coding task. It has hit a point where it needs expert guidance.\n\n" +
  "You will be given the full conversation history so far, followed by the specific question.\n\n" +
  "Provide clear, direct, actionable advice. Be concise — the working model will synthesize your " +
  "response into its next steps. Focus on the single highest-leverage insight or direction."

// Mirror opencode's own transcript format so the advisor sees the same
// structured view as a human reading the session. Structural types matching
// the V2 flat message union (SessionMessageInfo in @opencode/client):
// user/synthetic/system carry `text`; assistant carries `content` items.

type ToolContent = { type?: string; text?: string }

type ContentItem = {
  type?: string
  text?: string
  name?: string
  state?: {
    status?: string
    input?: unknown
    content?: ToolContent[]
    error?: unknown
  }
}

type TranscriptMessage = {
  type?: string
  text?: string
  content?: ContentItem[]
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === "string" ? message : JSON.stringify(err)
}

function formatContentItem(item: ContentItem, maxToolOutput?: number): string {
  if (item.type === "text") {
    if (!item.text?.trim()) return ""
    return `${item.text}\n\n`
  }

  if (item.type === "tool") {
    if (item.name === "ask_advisor") return "" // skip recursive calls
    let result = `**Tool: ${item.name}**\n`
    const state = item.state
    if (state?.input && typeof state.input === "object" && Object.keys(state.input).length > 0) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(state.input, null, 2)}\n\`\`\`\n`
    }
    if (state?.status === "completed" && state.content) {
      const output = state.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n")
      if (output) {
        const shown =
          maxToolOutput !== undefined && output.length > maxToolOutput
            ? output.slice(0, maxToolOutput) + `\n…(truncated, ${output.length} chars total)`
            : output
        result += `\n**Output:**\n\`\`\`\n${shown}\n\`\`\`\n`
      }
    }
    if (state?.status === "error" && state.error) {
      result += `\n**Error:**\n\`\`\`\n${errorText(state.error)}\n\`\`\`\n`
    }
    result += "\n"
    return result
  }

  return "" // reasoning and other content types are skipped
}

function formatTranscript(messages: readonly TranscriptMessage[], maxToolOutput?: number): string {
  return messages
    .map((message) => {
      if (message.type === "user" && message.text?.trim()) {
        return `## User\n\n${message.text}`
      }
      if (message.type === "assistant" && message.content) {
        const body = message.content.map((item) => formatContentItem(item, maxToolOutput)).join("")
        return body.trim() ? `## Assistant\n\n${body}` : null
      }
      return null // synthetic/system/compaction/etc. are skipped
    })
    .filter(Boolean)
    .join("---\n\n")
}

// "provider/model" — first slash splits (provider IDs contain no slash)
function parseAdvisorModel(str: string): { providerID: string; id: string } {
  const slash = str.indexOf("/")
  if (slash === -1)
    throw new Error(`Advisor model must be "provider/model" format, got: "${str}"`)
  return { providerID: str.slice(0, slash), id: str.slice(slash + 1) }
}

type AdvisorConfig = {
  model: { providerID: string; id: string }
  modelSource: string
  maxToolOutput: number | undefined
}

async function resolveConfig(directory: string, options: Record<string, unknown> = {}): Promise<AdvisorConfig> {
  let fileConfig: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(directory, ".opencode", "advisor.json"), "utf-8")
    fileConfig = JSON.parse(raw)
  } catch { /* no config file — use defaults */ }

  const modelStr = process.env.ADVISOR_MODEL
    ?? (typeof options.model === "string" ? options.model : null)
    ?? (typeof fileConfig.model === "string" ? fileConfig.model : null)
    ?? "anthropic/claude-opus-4-7"
  const modelSource = process.env.ADVISOR_MODEL
    ? "env:ADVISOR_MODEL"
    : typeof options.model === "string" ? "opencode.jsonc plugin options"
    : fileConfig.model ? ".opencode/advisor.json" : "default"

  const maxToolOutput = typeof options.maxToolOutput === "number"
    ? options.maxToolOutput
    : typeof fileConfig.maxToolOutput === "number"
      ? fileConfig.maxToolOutput
      : undefined

  return { model: parseAdvisorModel(modelStr), modelSource, maxToolOutput }
}

export default Plugin.define({
  id: "opencode-advisor",
  async setup(ctx) {
    const directory = ctx.location.directory
    const config = await resolveConfig(directory, ctx.options as Record<string, unknown>)
    console.log(`[${SERVICE}] advisor model: ${config.model.providerID}/${config.model.id} (${config.modelSource})`)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ask_advisor",
        description:
          "Consult a more powerful model for guidance when you are genuinely stuck, need " +
          "architectural advice, or face a critical decision with non-obvious tradeoffs. " +
          "Use sparingly — only for hard problems where expert input materially changes the outcome. " +
          "Session context is gathered automatically; just state your question.",
        input: {
          type: "object",
          properties: { question: { type: "string" } },
          required: ["question"],
          additionalProperties: false,
        },
        execute: async (input, toolCtx) => {
          const { question } = input as { question: string }
          const sessionID = (toolCtx as { sessionID?: string }).sessionID ?? ""

          // --- Gather current session transcript ---
          let transcript = ""
          try {
            const messages = await ctx.session.context({ sessionID })
            transcript = formatTranscript(messages, config.maxToolOutput)
          } catch (err) {
            console.warn(`[${SERVICE}] Failed to fetch transcript — continuing without it:`, err)
          }

          // --- Create advisor session, point it at the advisor model ---
          const advisorSession = await ctx.session.create({ title: "Advisor consultation" })
          await ctx.session.switchModel({
            sessionID: advisorSession.id,
            model: { providerID: config.model.providerID, id: config.model.id },
          })

          // --- Build prompt and call advisor model ---
          const promptText = [
            ADVISOR_SYSTEM,
            `Working directory: ${directory}`,
            transcript && `--- Session so far ---\n${transcript}\n--- End of session ---`,
            `Question:\n${question}`,
          ]
            .filter(Boolean)
            .join("\n\n")

          const { text } = await ctx.session.generate({ sessionID: advisorSession.id, prompt: promptText })
          return { content: text }
        },
      })
    })
  },
})
