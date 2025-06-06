#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import { randomUUID } from "node:crypto";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
  },
});

// Function to get HTTP headers.
// Supports only "sse" and "streamable-http" transport types.
const getHttpHeaders = (
  req: express.Request,
  transportType: string,
): HeadersInit => {
  const headers: HeadersInit = {
    Accept:
      transportType === "sse"
        ? "text/event-stream"
        : "text/event-stream, application/json",
  };
  const defaultHeaders =
    transportType === "sse"
      ? SSE_HEADERS_PASSTHROUGH
      : STREAMABLE_HTTP_HEADERS_PASSTHROUGH;

  for (const key of defaultHeaders) {
    if (req.headers[key] === undefined) {
      continue;
    }

    const value = req.headers[key];
    headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }

  // If the header "x-custom-auth-header" is present, use its value as the custom header name.
  if (req.headers["x-custom-auth-header"] !== undefined) {
    const customHeaderName = req.headers["x-custom-auth-header"] as string;
    const lowerCaseHeaderName = customHeaderName.toLowerCase();
    if (req.headers[lowerCaseHeaderName] !== undefined) {
      const value = req.headers[lowerCaseHeaderName];
      headers[customHeaderName] = value as string;
    }
  }
  return headers;
};

const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const clientFacingTransports: Map<string, Transport> = new Map<string, Transport>(); // Client-facing transports by web app sessionId
const serverFacingTransports: Map<string, Transport> = new Map<string, Transport>(); // Server-facing Transports by web app sessionId

const createServerFacingTransport = async (req: express.Request): Promise<Transport> => {
  const query = req.query;
  console.log("Query parameters:", JSON.stringify(query));

  const transportType = query.transportType as string;

  if (transportType === "stdio") {
    const command = query.command as string;
    const origArgs = shellParseArgs(query.args as string) as string[];
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...process.env, ...defaultEnvironment, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    console.log(`STDIO transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();
    return transport;
  } else if (transportType === "sse") {
    const url = query.url as string;

    const headers = getHttpHeaders(req, transportType);

    console.log(`SSE transport: url=${url}, headers=${Object.keys(headers)}`);

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    await transport.start();
    return transport;
  } else if (transportType === "streamable-http") {
    const headers = getHttpHeaders(req, transportType);
    const transport = new StreamableHTTPClientTransport(
      new URL(query.url as string),
      {
        requestInit: {
          headers,
        },
      },
    );
    await transport.start();
    return transport;
  } else {
    console.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  console.log(`Received GET message for sessionId ${sessionId}`);
  try {
    const transport = clientFacingTransports.get(
      sessionId,
    ) as StreamableHTTPServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    } else {
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    console.error("Error in /mcp route:", error);
    res.status(500).json(error);
  }
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let serverFacingTransport: Transport | undefined;
  if (!sessionId) {
    try {
      console.log("New StreamableHttp connection request");
      try {
        serverFacingTransport = await createServerFacingTransport(req);
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server:",
            error.message,
          );
          res.status(401).json(error);
          return;
        }

        throw error;
      }

      console.log("Created StreamableHttp server transport");

      const clientFacingTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          clientFacingTransports.set(sessionId, clientFacingTransport);
          serverFacingTransports.set(sessionId, serverFacingTransport!);
          console.log("Client <-> Proxy  sessionId: " + sessionId);
        },
      });
      console.log("Created StreamableHttp client transport");

      await clientFacingTransport.start();

      mcpProxy({
        transportToClient: clientFacingTransport,
        transportToServer: serverFacingTransport,
      });

      await (clientFacingTransport as StreamableHTTPServerTransport).handleRequest(
        req,
        res,
        req.body,
      );
    } catch (error) {
      console.error("Error in /mcp POST route:", error);
      res.status(500).json(error);
    }
  } else {
    console.log(`Received POST message for sessionId ${sessionId}`);
    try {
      const transport = clientFacingTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        await (transport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
        );
      }
    } catch (error) {
      console.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.log(`Received DELETE message for sessionId ${sessionId}`);
  let serverFacingTransport: Transport | undefined;
  if (sessionId) {
    try {
      serverFacingTransport = serverFacingTransports.get(
        sessionId,
      ) as StreamableHTTPClientTransport;
      if (!serverFacingTransport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        await (
          serverFacingTransport as StreamableHTTPClientTransport
        ).terminateSession();
        clientFacingTransports.delete(sessionId);
        serverFacingTransports.delete(sessionId);
        console.log(`Transports removed for sessionId ${sessionId}`);
      }
      res.status(200).end();
    } catch (error) {
      console.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  }
});

app.get("/stdio", async (req, res) => {
  try {
    console.log("New STDIO connection request");
    let serverFacingTransport: Transport | undefined;
    try {
      serverFacingTransport = await createServerFacingTransport(req);
      console.log("Created server transport");
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      }

      throw error;
    }

    const clientFacingTransport = new SSEServerTransport("/message", res);
    console.log("Created client transport");

    clientFacingTransports.set(clientFacingTransport.sessionId, clientFacingTransport);
    serverFacingTransports.set(clientFacingTransport.sessionId, serverFacingTransport);

    await clientFacingTransport.start();

    (serverFacingTransport as StdioClientTransport).stderr!.on("data", (chunk) => {
      if (chunk.toString().includes("MODULE_NOT_FOUND")) {
        clientFacingTransport.send({
          jsonrpc: "2.0",
          method: "notifications/stderr",
          params: {
            content: "Command not found, transports removed",
          },
        });
        clientFacingTransport.close();
        serverFacingTransport.close();
        clientFacingTransports.delete(clientFacingTransport.sessionId);
        serverFacingTransports.delete(clientFacingTransport.sessionId);
        console.error("Command not found, transports removed");
      } else {
        clientFacingTransport.send({
          jsonrpc: "2.0",
          method: "notifications/stderr",
          params: {
            content: chunk.toString(),
          },
        });
      }
    });

    mcpProxy({
      transportToClient: clientFacingTransport,
      transportToServer: serverFacingTransport,
    });
  } catch (error) {
    console.error("Error in /stdio route:", error);
    res.status(500).json(error);
  }
});

app.get("/sse", async (req, res) => {
  try {
    console.log(
      "New SSE connection request. NOTE: The sse transport is deprecated and has been replaced by StreamableHttp",
    );
    let serverFacingTransport: Transport | undefined;
    try {
      serverFacingTransport = await createServerFacingTransport(req);
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      } else if (error instanceof SseError && error.code === 404) {
        console.error(
          "Received 404 not found from MCP server. Does the MCP server support SSE?",
        );
        res.status(404).json(error);
        return;
      } else if (JSON.stringify(error).includes("ECONNREFUSED")) {
        console.error("Connection refused. Is the MCP server running?");
        res.status(500).json(error);
      } else {
        throw error;
      }
    }

    if (serverFacingTransport) {
      const clientFacingTransport = new SSEServerTransport("/message", res);
      clientFacingTransports.set(clientFacingTransport.sessionId, clientFacingTransport);
      console.log("Created client transport");
      serverFacingTransports.set(clientFacingTransport.sessionId, serverFacingTransport!);
      console.log("Created server transport");

      await clientFacingTransport.start();

      mcpProxy({
        transportToClient: clientFacingTransport,
        transportToServer: serverFacingTransport,
      });
    }
  } catch (error) {
    console.error("Error in /sse route:", error);
    res.status(500).json(error);
  }
});

app.post("/message", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    console.log(`Received POST message for sessionId ${sessionId}`);

    const transport = clientFacingTransports.get(
      sessionId as string,
    ) as SSEServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error in /message route:", error);
    res.status(500).json(error);
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.get("/config", (req, res) => {
  try {
    res.json({
      defaultEnvironment,
      defaultCommand: values.env,
      defaultArgs: values.args,
    });
  } catch (error) {
    console.error("Error in /config route:", error);
    res.status(500).json(error);
  }
});

const PORT = process.env.PORT || 6277;

const server = app.listen(PORT);
server.on("listening", () => {
  console.log(`⚙️ Proxy server listening on port ${PORT}`);
});
server.on("error", (err) => {
  if (err.message.includes(`EADDRINUSE`)) {
    console.error(`❌  Proxy Server PORT IS IN USE at port ${PORT} ❌ `);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
