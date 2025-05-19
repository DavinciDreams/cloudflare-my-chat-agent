import { routeAgentRequest, type Schedule } from "agents";

import { unstable_getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";
// import { openai } from "@ai-sdk/openai";
// Replaced with OpenRouter integration below

import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
// import { env } from "cloudflare:workers";

// OpenRouter integration
const OPENROUTER_API_KEY = (globalThis as any).env?.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = (globalThis as any).env?.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// Use Qwen model by default
async function openrouterChatCompletion(messages: {role: string; content: string}[], model: string = 'qwen/qwen3-235b-a22b:free') {
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${await response.text()}`);
  }
  return response.json();
}


/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * Handles incoming chat messages and manages the response stream
   * @param onFinish - Callback function executed when streaming completes
   */

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.unstable_getAITools(),
    };

    // Create a streaming response that handles both text and tool outputs
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: allTools,
          executions,
        });

        // Call OpenRouter for chat completion using Qwen
        try {
          const systemPrompt = `You are a helpful assistant that can do various tasks...\n\n${unstable_getSchedulePrompt({ date: new Date() })}\n\nIf the user asks to schedule a task, use the schedule tool to schedule the task.`;
          // OpenRouter expects system prompt as a message
          const orMessages = [
            { role: 'system', content: systemPrompt },
            ...processedMessages.map((m: any) => ({ role: m.role, content: m.content }))
          ];
          const result = await openrouterChatCompletion(orMessages, 'qwen/qwen3-235b-a22b:free');
          // Stream the response into dataStream
          if (result.choices && result.choices[0] && result.choices[0].message) {
            dataStream.send({
              type: 'text',
              content: result.choices[0].message.content
            });
            onFinish({
              message: result.choices[0].message
            } as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
          } else {
            throw new Error('No valid response from OpenRouter');
          }
        } catch (error) {
          console.error("Error while streaming:", error);
        }
      },
    });

    return dataStreamResponse;
  }
  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `Running scheduled task: ${description}`,
        createdAt: new Date(),
      },
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey,
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
