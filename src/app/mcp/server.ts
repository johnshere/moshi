/**
 * MCP 面（详设 §4.1 / 概设 §1.5）。
 *
 * 用 **Streamable HTTP** 而不是 stdio：宿主是"任意本地 Agent"，stdio 要求由宿主
 * 拉起子进程，等于把生命周期交给对方；HTTP 则挂在已经跑着的 daemon 上，
 * 宿主连上来、连不上都不影响 daemon 自己工作（概设 §1.5 的"零调用可用"）。
 *
 * **无状态模式**（`sessionIdGenerator: undefined`，每个请求一套 server + transport）：
 * 我们的工具本身无会话状态（`query_id` 就在返回值里），有状态只会带来
 * "宿主重连后 session 失效"这一整类故障，收益是零。
 *
 * 三个必须显式处理的点：
 * - **GET / DELETE 一律 405**：无状态模式下没有 SSE 流可开、没有 session 可删，
 *   静默挂住一个 GET 会让宿主以为连接可用；
 * - **体积上限**：`memory_annotate` 一次最多 50 条 × 2 KB，1 MB 上限已经宽松；
 *   不设上限的话，一个写错的客户端能把 daemon 的内存打穿；
 * - **路径只认 `/mcp`**：其他路径回 404 JSON，不落到 MCP 处理器里（否则 404 会变成协议错误）。
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { VERSION } from '../version.js';
import type { McpDeps } from './deps.js';
import { TOOL_SPECS, callTool } from './tools.js';

export const MCP_PATH = '/mcp';

/** 1 MB：够 50 条 × 2 KB 的事实再乘十倍，同时不至于让一次误发拖垮进程 */
export const MAX_BODY_BYTES = 1024 * 1024;

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  writeJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`请求体超过 ${String(MAX_BODY_BYTES)} 字节`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 建一个**只服务这一轮请求**的 MCP server。
 *
 * 每次新建而不是复用：无状态模式下 transport 与 server 是一对一绑定的，
 * 复用会让第二个请求拿到已经被 `close()` 的 transport。
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'moshi', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Local memory of this machine: ports, processes, packages, versions, paths and build ' +
        'results observed from previous sessions. Query it when a question depends on this ' +
        "machine's current state.",
    },
  );

  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.shape,
        annotations: spec.annotations,
      },
      (args) => callTool(deps, spec.name, args as Record<string, unknown>),
    );
  }

  return server;
}

/** 把 MCP 面挂成一个 `http.RequestListener`，交给 `boot()` 的 `handlerFactory` */
export function createMcpHttpHandler(deps: McpDeps): http.RequestListener {
  return (req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== MCP_PATH) {
        writeJson(res, 404, { error: 'E_NOT_FOUND', path: url.pathname });
        return;
      }
      if (req.method !== 'POST') {
        // 无状态模式：没有 SSE 流、没有 session 可删
        res.setHeader('allow', 'POST');
        rpcError(res, 405, -32000, 'method not allowed: stateless MCP accepts POST only');
        return;
      }

      let body: unknown;
      try {
        const text = await readBody(req);
        body = text === '' ? undefined : JSON.parse(text);
      } catch (err) {
        rpcError(res, 400, -32700, `parse error: ${(err as Error).message}`);
        return;
      }

      const server = createMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          rpcError(res, 500, -32603, `internal error: ${(err as Error).message}`);
        } else {
          res.end();
        }
      }
    })();
  };
}
