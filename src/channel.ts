import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { WrittenSnapshot } from './external-usage.ts';
import type { AgyQuotaProbe, StdinData } from './types.ts';

export type Probe =
  | 'git.status'
  | 'git.numstat'
  | 'git.branch'
  | 'git.describe'
  | 'git.hooks'
  | 'git.repo'
  | 'jj'
  | 'memory'
  | 'extra'
  | 'usage.read'
  | 'usage.target'
  | 'agy.quota'
  | 'agy.unicode';

export type Ask = (names: Probe[]) => Promise<Record<Probe, unknown>>;

export interface Paths {
  data: string;
  config: string;
  override: string;
  legacyConfig: string;
  heartbeat: string;
  claudeJson: string;
  user: {
    claudeMd: string;
    geminiMd: string;
    rules: string;
    agyRules: string;
    agents?: string;
    agyConfigAgents?: string;
    agyAgents?: string;
    agyCliAgents?: string;
    settings: string;
    agySettings: string;
    mcpConfig?: string;
    agyMcpConfig?: string;
    agyHookFiles?: string[];
  };
  project: {
    claudeMd: string;
    localMd: string;
    agentsMd: string;
    geminiMd: string;
    memoryMd: string;
    mcpJson: string;
    localAgyHudConfig: string;
    dotClaudeMd: string | null;
    dotLocalMd: string;
    rules: string | null;
    geminiRules: string | null;
    agentsRules: string | null;
    cursorRules: string | null;
    githubRules: string | null;
    agents?: string | null;
    geminiAgents?: string | null;
    agentsAgents?: string | null;
    settings: string | null;
    localSettings: string;
  } | null;
  projectMemory: string | null;
  transcript: string | null;
  subagents: string | null;
  agySubagentTranscripts?: Record<string, string>;
  todoFiles?: string[];
}

export interface Facts {
  runtime: {
    name: string;
    version: string;
    path: string;
    supported: boolean;
  };
  runtimes: Array<{ name: string; version: string; path: string }>;
  plugin: {
    root: string;
    version: string | null;
  };
  configPath: string;
  undoPath: string;
  cwd: string;
  account: {
    email: string | null;
    tier: string | null;
  };
  heartbeat: {
    at?: number;
    runtime?: string;
    path?: string;
    outcome?: string;
    columns?: number | null;
    stdin?: StdinData | null;
  } | null;
  agyQuota?: AgyQuotaProbe | null;
}

export interface CommandRequest {
  name: 'doctor' | 'schema' | 'preview' | 'set' | 'preset' | 'report';
  args: string[];
  facts: Facts;
}

export interface InitMessage {
  stdin: StdinData | null;
  now: number;
  paths: Paths;
  command?: CommandRequest;
  persistent?: boolean;
  cols?: number | null;
}

export interface ReplyMessage {
  lines: string[];
  snapshot?: WrittenSnapshot | null;
  config?: Record<string, unknown>;
  failed?: boolean;
}

export interface Channel {
  init: Promise<InitMessage>;
  ask: Ask;
  reply: (msg: ReplyMessage) => void;
  nextRequest: () => Promise<InitMessage | null>;
}

function createFdChannel(): Channel {
  let nextId = 1;
  let closed = false;
  let eof = false;
  let initSettled = false;
  let isPersistent = false;
  let reading = false;
  let remainder: Buffer = Buffer.alloc(0);
  const pending = new Map<number, (answers: Record<string, unknown>) => void>();
  const requestQueue: InitMessage[] = [];
  const requestWaiters: Array<(msg: InitMessage | null) => void> = [];

  let resolveInit!: (msg: InitMessage) => void;
  let rejectInit!: (err: Error) => void;
  const init = new Promise<InitMessage>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const enqueueRequest = (msg: InitMessage): void => {
    const waiter = requestWaiters.shift();
    if (waiter) waiter(msg);
    else requestQueue.push(msg);
  };

  const flushClosedState = (): void => {
    if (!initSettled) {
      initSettled = true;
      rejectInit(new Error('channel closed before init message'));
    }
    for (const done of pending.values()) done({});
    pending.clear();
    while (requestWaiters.length > 0) {
      requestWaiters.shift()!(null);
    }
  };

  const readOneChunk = (): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const buf = Buffer.allocUnsafe(8192);
      fs.read(0, buf, 0, buf.length, null, (err, bytesRead) => {
        if (err || bytesRead <= 0) resolve(null);
        else resolve(buf.subarray(0, bytesRead));
      });
    });

  const nextLine = async (): Promise<string | null> => {
    while (!closed) {
      const nl = remainder.indexOf(0x0a);
      if (nl !== -1) {
        const line = remainder.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        remainder = remainder.subarray(nl + 1);
        return line;
      }
      const chunk = await readOneChunk();
      if (chunk === null) {
        if (remainder.length > 0) {
          const line = remainder.toString('utf8').replace(/\r$/, '');
          remainder = Buffer.alloc(0);
          return line;
        }
        return null;
      }
      remainder = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
    }
    return null;
  };

  const dispatchLine = (raw: string): void => {
    if (!raw.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!;
      pending.delete(msg.id);
      done((msg.answers && typeof msg.answers === 'object' ? msg.answers : {}) as Record<string, unknown>);
      return;
    }
    if ('paths' in msg) {
      const req = msg as unknown as InitMessage;
      if (!initSettled) {
        initSettled = true;
        isPersistent = req.persistent === true;
        resolveInit(req);
      } else {
        enqueueRequest(req);
      }
    }
  };

  const shouldRead = (): boolean =>
    !closed && !eof && (!initSettled || isPersistent || pending.size > 0 || requestWaiters.length > 0);

  const pump = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      while (shouldRead()) {
        const raw = await nextLine();
        if (raw === null) {
          eof = true;
          flushClosedState();
          return;
        }
        dispatchLine(raw);
      }
    } finally {
      reading = false;
      if (shouldRead()) void pump();
    }
  };

  void pump();

  const safeWriteLine = (payload: unknown): boolean => {
    try {
      fs.writeSync(1, `${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const ask: Ask = (names) => {
    const unique = [...new Set(names)];
    if (unique.length === 0 || closed || eof) return Promise.resolve({} as Record<Probe, unknown>);
    const id = nextId++;
    return new Promise<Record<Probe, unknown>>((resolve) => {
      pending.set(id, (answers) => resolve(answers as Record<Probe, unknown>));
      if (!safeWriteLine({ id, ask: unique })) {
        pending.delete(id);
        closed = true;
        flushClosedState();
        resolve({} as Record<Probe, unknown>);
        return;
      }
      void pump();
    });
  };

  const nextRequest = (): Promise<InitMessage | null> => {
    if (requestQueue.length > 0) return Promise.resolve(requestQueue.shift()!);
    if (closed || eof) return Promise.resolve(null);
    return new Promise<InitMessage | null>((resolve) => {
      requestWaiters.push(resolve);
      void pump();
    });
  };

  const reply = (msg: ReplyMessage): void => {
    for (const done of pending.values()) done({});
    pending.clear();
    if (!isPersistent) {
      closed = true;
      while (requestWaiters.length > 0) {
        requestWaiters.shift()!(null);
      }
    }
    if (!safeWriteLine(msg)) {
      closed = true;
      flushClosedState();
    }
  };

  return { init, ask, reply, nextRequest };
}

export function createChannel(
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Channel {
  // Inside fence.mjs cage, process.stdin is sealed to undefined so logic reads fd 0 via node:fs.
  if (!input || !output) return createFdChannel();

  let nextId = 1;
  let closed = false;
  let eof = false;
  let isPersistent = false;
  const pending = new Map<number, (answers: Record<string, unknown>) => void>();
  const requestQueue: InitMessage[] = [];
  const requestWaiters: Array<(msg: InitMessage | null) => void> = [];
  let resolveInit!: (msg: InitMessage) => void;
  let rejectInit!: (err: Error) => void;
  let initSettled = false;

  const init = new Promise<InitMessage>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const enqueueRequest = (msg: InitMessage): void => {
    const waiter = requestWaiters.shift();
    if (waiter) waiter(msg);
    else requestQueue.push(msg);
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (raw) => {
    if (!raw.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!;
      pending.delete(msg.id);
      done((msg.answers && typeof msg.answers === 'object' ? msg.answers : {}) as Record<string, unknown>);
      return;
    }
    if ('paths' in msg) {
      const req = msg as unknown as InitMessage;
      if (!initSettled) {
        initSettled = true;
        isPersistent = req.persistent === true;
        resolveInit(req);
      } else {
        enqueueRequest(req);
      }
    }
  });

  rl.once('close', () => {
    eof = true;
    if (!initSettled) {
      initSettled = true;
      rejectInit(new Error('channel closed before init message'));
    }
    for (const done of pending.values()) done({});
    pending.clear();
    while (requestWaiters.length > 0) {
      requestWaiters.shift()!(null);
    }
  });

  const ask: Ask = (names) => {
    const unique = [...new Set(names)];
    if (unique.length === 0 || closed || eof) return Promise.resolve({} as Record<Probe, unknown>);
    const id = nextId++;
    return new Promise<Record<Probe, unknown>>((resolve) => {
      pending.set(id, (answers) => resolve(answers as Record<Probe, unknown>));
      output.write(`${JSON.stringify({ id, ask: unique })}\n`);
    });
  };

  const nextRequest = (): Promise<InitMessage | null> => {
    if (requestQueue.length > 0) return Promise.resolve(requestQueue.shift()!);
    if (closed || eof) return Promise.resolve(null);
    return new Promise<InitMessage | null>((resolve) => {
      requestWaiters.push(resolve);
    });
  };

  const reply = (msg: ReplyMessage): void => {
    for (const done of pending.values()) done({});
    pending.clear();
    output.write(`${JSON.stringify(msg)}\n`);
    if (!isPersistent) {
      closed = true;
      while (requestWaiters.length > 0) {
        requestWaiters.shift()!(null);
      }
      rl.close();
    }
  };

  return { init, ask, reply, nextRequest };
}
