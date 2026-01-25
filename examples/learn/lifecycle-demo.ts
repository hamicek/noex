// lifecycle-demo.ts
import { GenServer, type GenServerBehavior, type TerminateReason } from '../../src/index.js';

interface DatabaseState {
  connections: number;
  queries: string[];
}

type CallMsg =
  | { type: 'query'; sql: string }
  | { type: 'getStats' };

type CastMsg = { type: 'log' };

type Reply = string[] | { connections: number; totalQueries: number };

const databaseBehavior: GenServerBehavior<DatabaseState, CallMsg, CastMsg, Reply> = {
  // 1. INITIALIZATION
  init() {
    console.log('[init] Connecting to database...');
    // Simulate connection setup
    return {
      connections: 5, // Connection pool
      queries: [],
    };
  },

  // 2. MESSAGE HANDLING (running state)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'query': {
        console.log(`[handleCall] Executing: ${msg.sql}`);
        const newState = {
          ...state,
          queries: [...state.queries, msg.sql],
        };
        return [[msg.sql], newState]; // Return "results"
      }
      case 'getStats':
        return [
          { connections: state.connections, totalQueries: state.queries.length },
          state,
        ];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'log') {
      console.log(`[handleCast] Total queries executed: ${state.queries.length}`);
    }
    return state;
  },

  // 3. CLEANUP (stopping state)
  terminate(reason: TerminateReason, state: DatabaseState) {
    console.log('[terminate] Shutting down database connection...');
    console.log(`[terminate] Reason: ${formatReason(reason)}`);
    console.log(`[terminate] Executed ${state.queries.length} queries during lifetime`);

    // Close all connections in the pool
    for (let i = 0; i < state.connections; i++) {
      console.log(`[terminate] Closing connection ${i + 1}/${state.connections}`);
    }

    console.log('[terminate] All connections closed');
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normal shutdown';
  if (reason === 'shutdown') return 'system shutdown';
  return `error: ${reason.error.message}`;
}

async function main() {
  // Register lifecycle observer
  GenServer.onLifecycleEvent((event) => {
    console.log(`[lifecycle] ${event.type.toUpperCase()}`);
  });

  console.log('=== Starting server ===');
  const db = await GenServer.start(databaseBehavior);

  console.log('\n=== Running queries ===');
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM users' });
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM orders' });
  GenServer.cast(db, { type: 'log' });

  // Wait for cast to process
  await new Promise((r) => setTimeout(r, 10));

  const stats = await GenServer.call(db, { type: 'getStats' });
  console.log('\n=== Stats ===');
  console.log(stats);

  console.log('\n=== Stopping server ===');
  await GenServer.stop(db, 'shutdown');

  console.log('\n=== Server stopped ===');
}

main().catch(console.error);
