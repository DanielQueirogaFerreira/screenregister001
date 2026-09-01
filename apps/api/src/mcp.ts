import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env, Principal } from './types.js';
import {
  buildScenes, listFrames, listSessions, resolveWindow, type FrameRow,
} from './queries.js';

/**
 * The LLM-facing surface.
 *
 * The design constraint is context, not capability. Seven days of frames is thousands of
 * images; an assistant that had to download them to answer "what was I doing Tuesday
 * afternoon" would exhaust its context before it got to the answer. So the tools are
 * deliberately layered: `get_scene_summary` and `search_timeline` return only text and
 * are cheap enough to call speculatively, and `get_frame` — the only tool that returns
 * pixels — is called last, for the handful of moments that turned out to matter.
 *
 * Stateless by design: a fresh server and transport per request, so no session state has
 * to survive between Worker invocations and no Durable Object is required.
 */

const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

const clock = (iso: string): string => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** R2 gives us bytes; MCP image blocks want base64. Chunked to avoid blowing the stack. */
function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function buildServer(env: Env, me: Principal): McpServer {
  const server = new McpServer(
    { name: 'screenregister', version: '0.1.0' },
    {
      instructions:
        'Screen history for this user, covering roughly the last 7 days. Every stored ' +
        'frame is a moment the screen actually changed; unchanged stretches are a single ' +
        'frame with a long hold, so gaps in frame times mean "nothing changed", not ' +
        '"no data". Start with get_scene_summary to see the shape of a period, narrow ' +
        'with search_timeline, and only then call get_frame on the few frames that matter ' +
        '— images are expensive and the text tools usually answer the question.',
    },
  );

  const q = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);

  server.registerTool(
    'list_sessions',
    {
      title: 'List recording sessions',
      description:
        'Recording sessions in a time window, newest first. A session is one continuous ' +
        'screen share. Use this to find out whether the screen was being recorded at all ' +
        'during a period before looking for content.',
      inputSchema: {
        last_hours: z.number().optional().describe('Look back this many hours (default 24)'),
        from: z.string().optional().describe('ISO-8601 UTC start; overrides last_hours'),
        to: z.string().optional().describe('ISO-8601 UTC end'),
      },
    },
    async (args) => {
      const w = resolveWindow(args);
      const results = await listSessions(env, me.userId, w);

      if (results.length === 0) {
        return text(`No recording sessions between ${clock(w.from)} and ${clock(w.to)}.`);
      }
      const lines = results.map((s) => {
        const len = s.ended_at
          ? duration(Date.parse(String(s.ended_at)) - Date.parse(String(s.started_at)))
          : 'still open';
        return `${clock(String(s.started_at))}  ${String(s.session_id)}  ${len}  ${s.frame_count} frames  ` +
          `${s.screen_w}x${s.screen_h}  ${s.capture_fps} FPS`;
      });
      return text(
        `${results.length} session(s) between ${clock(w.from)} and ${clock(w.to)}:\n\n${lines.join('\n')}`,
      );
    },
  );

  server.registerTool(
    'get_scene_summary',
    {
      title: 'Summarise a period as scenes',
      description:
        'Collapses a period into scenes — runs where the screen stayed essentially the ' +
        'same. This is the cheapest way to understand a stretch of time: an eight-hour ' +
        'day usually reduces to a few dozen lines. Each scene names the frame that opened ' +
        'it, so you can fetch that one image if a scene looks relevant.',
      inputSchema: {
        last_hours: z.number().optional().describe('Look back this many hours (default 24)'),
        from: z.string().optional(),
        to: z.string().optional(),
        min_scene_ms: z.number().optional().describe('Ignore scenes shorter than this (default 5000)'),
      },
    },
    async (args) => {
      const w = resolveWindow(args);
      const minMs = args.min_scene_ms ?? 5000;
      const results = await listFrames(env, me.userId, w, { limit: 5000 });

      if (results.length === 0) return text(`No frames between ${clock(w.from)} and ${clock(w.to)}.`);

      const { scenes, hidden } = buildScenes(results, minMs);
      const lines = scenes.map(
        (s) =>
          `${clock(s.start_at)}  ${duration(s.duration_ms).padStart(7)}  ${String(s.frame_count).padStart(4)} frames  ` +
          `peak change ${(s.peak_change * 100).toFixed(0).padStart(3)}%  ${s.start_frame_id}`,
      );
      const covered = scenes.reduce((n, s) => n + s.duration_ms, 0);
      return text(
        `${scenes.length} scene(s) between ${clock(w.from)} and ${clock(w.to)}, covering ${duration(covered)} ` +
          `of screen time from ${results.length} stored frames.\n` +
          `Columns: start · how long the screen stayed this way · frames · peak change · opening frame id\n\n` +
          lines.join('\n') +
          (hidden > 0 ? `\n\n(${hidden} scene(s) shorter than ${duration(minMs)} hidden)` : ''),
      );
    },
  );

  server.registerTool(
    'search_timeline',
    {
      title: 'List individual frames',
      description:
        'Individual stored frames in a time window, as text — no images. Filter by how ' +
        'much of the screen changed, or by why the frame was kept. Use this to pinpoint ' +
        'the exact moment something happened once get_scene_summary has narrowed the period.',
      inputSchema: {
        last_hours: z.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        min_change: z.number().optional().describe('Only frames where at least this fraction (0-1) of the screen changed'),
        reason: z.enum(['first', 'scene_change', 'settled', 'burst', 'heartbeat', 'final']).optional(),
        limit: z.number().optional().describe('Default 100, max 500'),
      },
    },
    async (args) => {
      const w = resolveWindow(args);
      const limit = Math.min(args.limit ?? 100, 500);
      const results = await listFrames(env, me.userId, w, {
        minChange: args.min_change, reason: args.reason, limit,
      });

      if (results.length === 0) return text(`No matching frames between ${clock(w.from)} and ${clock(w.to)}.`);
      const lines = results.map(
        (f) => `${clock(f.captured_at)}  ${f.frame_id}  ${f.reason.padEnd(12)} held ${duration(f.hold_ms ?? 0).padStart(7)}  ` +
          `change ${(f.change_score * 100).toFixed(0).padStart(3)}%`,
      );
      return text(
        `${results.length} frame(s)${results.length === limit ? ' (limit reached)' : ''} between ` +
          `${clock(w.from)} and ${clock(w.to)}:\n\n${lines.join('\n')}\n\n` +
          `Pass any frame id to get_frame to see the screen at that moment.`,
      );
    },
  );

  server.registerTool(
    'get_frame',
    {
      title: 'Get the screen image at one moment',
      description:
        'Returns the actual screenshot for one frame id. This is the expensive tool — ' +
        'prefer the thumbnail variant when you only need the gist, and call it on ' +
        'specific frames rather than sweeping a range.',
      inputSchema: {
        frame_id: z.string().describe('A frame id from search_timeline or get_scene_summary'),
        variant: z.enum(['full', 'thumb']).optional().describe('thumb is ~320px wide and much cheaper (default full)'),
      },
    },
    async (args) => {
      const row = await q(
        `SELECT storage_key, captured_at, hold_ms, change_score, reason FROM frames
         WHERE frame_id = ? AND user_id = ?`,
        args.frame_id, me.userId,
      ).first<FrameRow>();
      if (!row) return { ...text(`No frame ${args.frame_id} for this user.`), isError: true };

      const key = args.variant === 'thumb' ? row.storage_key.replace(/^f\//, 't/') : row.storage_key;
      const obj = await env.FRAMES.get(key);
      if (!obj) {
        return {
          ...text(`Frame ${args.frame_id} is catalogued but its image is gone (likely expired).`),
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Screen at ${clock(row.captured_at)} — stayed this way for ${duration(row.hold_ms ?? 0)} ` +
              `(kept because: ${row.reason})`,
          },
          {
            type: 'image' as const,
            data: toBase64(await obj.arrayBuffer()),
            mimeType: 'image/webp',
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_frames',
    {
      title: 'Get several screen images at once',
      description:
        'Batch version of get_frame, for comparing a few moments side by side. Capped at ' +
        '8 frames and forced to thumbnails, because a dozen full screenshots will crowd ' +
        'out whatever you were trying to reason about.',
      inputSchema: {
        frame_ids: z.array(z.string()).max(8).describe('Up to 8 frame ids'),
      },
    },
    async (args) => {
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
      for (const id of args.frame_ids.slice(0, 8)) {
        const row = await q(
          `SELECT storage_key, captured_at, hold_ms, reason FROM frames WHERE frame_id = ? AND user_id = ?`,
          id, me.userId,
        ).first<FrameRow>();
        if (!row) {
          content.push({ type: 'text', text: `${id}: not found` });
          continue;
        }
        const obj = await env.FRAMES.get(row.storage_key.replace(/^f\//, 't/'));
        if (!obj) {
          content.push({ type: 'text', text: `${id}: image expired` });
          continue;
        }
        content.push({ type: 'text', text: `${clock(row.captured_at)} — held ${duration(row.hold_ms ?? 0)}` });
        content.push({ type: 'image', data: toBase64(await obj.arrayBuffer()), mimeType: 'image/webp' });
      }
      return { content };
    },
  );

  return server;
}

/**
 * One request, one server. Stateless mode means nothing has to survive between Worker
 * invocations, which is what lets this run without a Durable Object.
 */
export async function handleMcp(req: Request, env: Env, me: Principal): Promise<Response> {
  const server = buildServer(env, me);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
