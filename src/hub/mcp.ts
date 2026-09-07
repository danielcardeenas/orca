/**
 * The hub as an MCP server: `POST /mcp`.
 *
 * This is what makes the fleet command runtime-agnostic. The tools that used
 * to exist only inside an Anthropic SDK loop — survey, spawn, redirect, stop,
 * recall, answer, escalate — are published here as Model Context Protocol
 * tools, so *any* CLI that speaks MCP can be CAPCOM. Claude Code today, Codex
 * or anything else the day it has an adapter, with no change on this side.
 *
 * It also moves the bill. A CLI session runs on the operator's subscription;
 * the API loop ran on their API key. Same tools, same hub, zero API spend.
 *
 * ── Transport ──────────────────────────────────────────────────────
 *
 * Streamable HTTP (MCP 2025-03-26), the JSON-only half of it: a JSON-RPC 2.0
 * message in the POST body, a JSON-RPC response in the body of the reply. The
 * spec lets a server answer `application/json` directly instead of opening an
 * SSE stream, and every tool here answers in milliseconds without pushing
 * anything of its own, so a stream would be a socket held open for nothing.
 * A notification (no `id`) gets `202 Accepted` and an empty body, as required.
 *
 * `GET /mcp` — the client's request for a server-initiated stream — is a clean
 * 405: saying "I do not do that" is what the spec asks for, and it is how a
 * client knows not to wait.
 *
 * ── Written without an SDK, on purpose ─────────────────────────────
 *
 * `@modelcontextprotocol/sdk` would bring a dependency and a second HTTP
 * server abstraction into a process that already has one, to save about
 * sixty lines of switch statement. The surface actually used here — five
 * methods, one content type — is small enough that the switch IS the spec, and
 * reading it is faster than reading the SDK's.
 *
 * ── Authentication ─────────────────────────────────────────────────
 *
 * The same door as `/api/artifact`: the hub's token, in `Authorization:
 * Bearer`, `X-Orca-Token`, or `?token=`. The query form is not laziness — it
 * is the only one a `.mcp.json` entry can carry, since that file has no place
 * to put a header the CLI will send. Everything this endpoint exposes is
 * fleet command, so it is closed by default and never inherits the open door
 * that `/api/world` has.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { CEO_TOOLS, runTool, type CeoContext } from '../agents/tools.ts';

/** What we tell a client we speak. The spec version this file implements. */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

/**
 * Versions we will happily echo back.
 *
 * The handshake rule is "answer with the version you will use": the client's
 * own, when we can speak it, and ours otherwise so it can decide. All three of
 * these are wire-identical for what this server does — five methods, one
 * content type — so agreeing is honest rather than optimistic.
 */
const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/** A body bigger than this is not a tool call, it is an accident or an attack. */
const MAX_BODY_BYTES = 1024 * 1024;

export const MCP_SERVER_NAME = 'orca';

/* ── JSON-RPC ─────────────────────────────────────────────────────── */

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function result(id: string | number | null, value: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/* ── the tool surface ─────────────────────────────────────────────── */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * `CEO_TOOLS`, in MCP's shape.
 *
 * Derived and never copied: the list in tools.ts is the only definition of what
 * CAPCOM can do. Only the envelope changes — `input_schema` → `inputSchema`,
 * and the `strict` flag drops off because it is not a JSON-Schema keyword.
 */
export function mcpTools(): McpTool[] {
  return CEO_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
}

export interface McpContent { type: 'text'; text: string }
export interface McpToolResult { content: McpContent[]; isError?: boolean }

/**
 * Run one tool and dress the outcome for a model to read.
 *
 * The text is JSON on purpose: `summary` is the one line the console shows and
 * a person would say out loud, `result` is the payload. A model reading a wall
 * of prose has to infer what happened; a model reading two named fields does
 * not. A failed tool comes back as a *result* with `isError`, never as a
 * JSON-RPC error — a protocol error aborts the turn, and "that agent is gone"
 * is something CAPCOM should be able to read, explain, and route around.
 */
export async function mcpCall(
  ctx: CeoContext, name: string, args: Record<string, unknown>,
): Promise<McpToolResult> {
  const out = await runTool(ctx, name, args);
  let payload: unknown = out.result;
  try { payload = JSON.parse(out.result); } catch { /* not JSON: the string stands */ }
  const text = JSON.stringify({ summary: out.summary, result: payload }, null, 1);
  return out.isError ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/* ── method dispatch ──────────────────────────────────────────────── */

export interface McpDeps {
  /** Fresh every call: the fleet moves between one tool and the next. */
  context(): CeoContext;
  /** Shown in the CLI's `/mcp` listing. */
  version?: string;
  log?(message: string): void;
}

/**
 * One JSON-RPC message in, one response out — or null for a notification,
 * which by definition has no reply.
 */
export async function mcpDispatch(
  msg: RpcRequest, deps: McpDeps,
): Promise<RpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (typeof msg.params === 'object' && msg.params !== null
    ? msg.params : {}) as Record<string, unknown>;

  if (!method) {
    return isNotification ? null : failure(id, INVALID_REQUEST, 'missing method');
  }

  switch (method) {
    case 'initialize': {
      const wanted = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      return result(id, {
        protocolVersion: SPOKEN.has(wanted) ? wanted : MCP_PROTOCOL_VERSION,
        // No prompts, no resources, no subscriptions: this server is a set of
        // verbs. Claiming a capability it does not have would make a client
        // ask for a list that will always be empty.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: deps.version ?? '0.1.0' },
        instructions:
          'ORCA fleet command. These tools reach every agent on every machine this hub can see.'
          + ' Survey with list_fleet before you act. Before ask_human, always recall —'
          + ' the human should never answer the same question twice.'
          + ' `show` moves the operator\'s camera on the console; callsigns you write are clickable there.',
      });
    }

    // The client telling us the handshake is done. Nothing to do, and nothing
    // to say: a notification takes no response at all.
    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return isNotification ? null : result(id, {});

    case 'tools/list':
      return result(id, { tools: mcpTools() });

    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      if (!name) return failure(id, INVALID_REQUEST, 'tools/call needs a tool name');
      const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null
        ? params['arguments'] : {}) as Record<string, unknown>;
      try {
        const out = await mcpCall(deps.context(), name, args);
        deps.log?.(`tool ${name}${out.isError ? ' (error)' : ''}`);
        return result(id, out);
      } catch (err) {
        // runTool catches its own throws; reaching here means the hub itself
        // fell over, which is a protocol-level failure and should say so.
        return failure(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      }
    }

    // Declared-but-empty surfaces some clients probe on connect. An empty list
    // is a truthful answer and cheaper than an error the client has to special-case.
    case 'resources/list':
      return result(id, { resources: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });

    default:
      return isNotification ? null : failure(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────── */

export interface McpHttpDeps extends McpDeps {
  /** The hub's own token check. Returns null when allowed, or the reason why not. */
  authorize(req: IncomingMessage): string | null;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Serve one request on `/mcp`.
 *
 * Auth comes first and answers `401` with a plain JSON-RPC error rather than a
 * page: the thing on the other end is a CLI, and a body it can parse is what
 * turns "the MCP server failed" into "the token is wrong".
 */
export async function serveMcp(
  req: IncomingMessage, res: ServerResponse, deps: McpHttpDeps,
): Promise<void> {
  const denied = deps.authorize(req);
  if (denied !== null) {
    json(res, 401, failure(null, INVALID_REQUEST,
      `unauthorized (${denied}). Put the hub token in Authorization: Bearer, X-Orca-Token, or ?token=`));
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') {
    // Session teardown. This server keeps no session state, so there is
    // nothing to tear down and saying "fine" is the truth.
    res.writeHead(204).end();
    return;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST, DELETE' });
    res.end(JSON.stringify(failure(null, INVALID_REQUEST,
      'this MCP endpoint is POST-only: it answers JSON directly and opens no SSE stream')));
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    json(res, 413, failure(null, INVALID_REQUEST, err instanceof Error ? err.message : 'body too large'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, failure(null, PARSE_ERROR, 'body is not JSON'));
    return;
  }

  // A batch is a JSON array. Notifications inside it produce no entry, so a
  // batch of nothing but notifications correctly answers 202 with no body.
  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as RpcRequest[];
  if (messages.length === 0) {
    json(res, 400, failure(null, INVALID_REQUEST, 'empty batch'));
    return;
  }

  const out: RpcResponse[] = [];
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) {
      out.push(failure(null, INVALID_REQUEST, 'not a JSON-RPC message'));
      continue;
    }
    const answer = await mcpDispatch(msg, deps);
    if (answer) out.push(answer);
  }

  if (out.length === 0) { res.writeHead(202).end(); return; }
  json(res, 200, batch ? out : out[0]);
}
