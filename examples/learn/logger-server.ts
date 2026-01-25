// logger-server.ts - Exercise solution from lifecycle chapter
import { GenServer, type GenServerBehavior, type TerminateReason } from '../../src/index.js';

interface LoggerState {
  buffer: string[];
  totalFlushed: number;
}

type LoggerCallMsg = { type: 'flush' };
type LoggerCastMsg = { type: 'write'; message: string };
type LoggerReply = string[];

const loggerBehavior: GenServerBehavior<
  LoggerState,
  LoggerCallMsg,
  LoggerCastMsg,
  LoggerReply
> = {
  init() {
    console.log('[Logger] Initialized');
    return { buffer: [], totalFlushed: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'flush') {
      const messages = [...state.buffer];
      console.log(`[Logger] Flushing ${messages.length} messages`);
      return [
        messages,
        { buffer: [], totalFlushed: state.totalFlushed + messages.length },
      ];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    if (msg.type === 'write') {
      return {
        ...state,
        buffer: [...state.buffer, msg.message],
      };
    }
    return state;
  },

  terminate(reason: TerminateReason, state: LoggerState) {
    console.log(`[Logger] Terminating (reason: ${formatReason(reason)})`);
    console.log(`[Logger] Total flushed during lifetime: ${state.totalFlushed}`);

    if (state.buffer.length > 0) {
      console.log(`[Logger] ${state.buffer.length} unflushed messages:`);
      for (const msg of state.buffer) {
        console.log(`[UNFLUSHED] ${msg}`);
      }
    } else {
      console.log('[Logger] All messages were flushed');
    }
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normal';
  if (reason === 'shutdown') return 'shutdown';
  return `error: ${reason.error.message}`;
}

async function main() {
  const logger = await GenServer.start(loggerBehavior);

  // Write some messages
  GenServer.cast(logger, { type: 'write', message: 'First log entry' });
  GenServer.cast(logger, { type: 'write', message: 'Second log entry' });

  // Wait for casts to process
  await new Promise((r) => setTimeout(r, 10));

  // Flush
  const flushed = await GenServer.call(logger, { type: 'flush' });
  console.log('Flushed messages:', flushed);

  // Write more without flushing
  GenServer.cast(logger, { type: 'write', message: 'Third log entry' });
  GenServer.cast(logger, { type: 'write', message: 'Fourth log entry' });

  await new Promise((r) => setTimeout(r, 10));

  // Stop without flushing - terminate() will show unflushed messages
  console.log('\n--- Stopping logger ---');
  await GenServer.stop(logger);
}

main();
