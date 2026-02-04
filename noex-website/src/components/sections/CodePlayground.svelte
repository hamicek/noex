<script lang="ts">
  import { onMount } from 'svelte';

  interface PlaygroundTranslations {
    title: string;
    subtitle: string;
    examples: {
      counter: { name: string; description: string };
      chat: { name: string; description: string };
      worker: { name: string; description: string };
      stateMachine: { name: string; description: string };
    };
    terminal: {
      title: string;
      running: string;
      output: string;
    };
    actions: {
      copy: string;
      copied: string;
      run: string;
    };
  }

  interface Props {
    translations: PlaygroundTranslations;
  }

  let { translations }: Props = $props();

  // Visibility state for animations
  let sectionRef: HTMLElement | null = $state(null);
  let isVisible = $state(false);

  // Active example tab
  let activeExample = $state<'counter' | 'chat' | 'worker' | 'stateMachine'>('counter');

  // Copy state
  let copied = $state(false);

  // Terminal animation state
  let terminalLines = $state<string[]>([]);
  let isRunning = $state(false);

  // Code examples
  const examples = {
    counter: {
      code: `import { GenServer, Supervisor, Registry } from '@hamicek/noex';

class Counter extends GenServer<number> {
  init() {
    return 0;
  }

  handleCall(msg: { type: 'get' }) {
    return this.state;
  }

  handleCast(msg: { type: 'increment' } | { type: 'decrement' }) {
    if (msg.type === 'increment') {
      this.state++;
    } else {
      this.state--;
    }
  }
}

// Start the counter
const counter = await Counter.start();

// Interact with it
await counter.cast({ type: 'increment' });
await counter.cast({ type: 'increment' });
const value = await counter.call({ type: 'get' });

console.log('Counter value:', value);`,
      output: [
        '$ npx ts-node counter.ts',
        '',
        '✓ Counter process started (pid: <counter_1>)',
        '→ cast: { type: "increment" }',
        '→ cast: { type: "increment" }',
        '→ call: { type: "get" }',
        '← reply: 2',
        '',
        'Counter value: 2',
      ],
    },
    chat: {
      code: `import { GenServer, Registry, EventBus } from '@hamicek/noex';

interface ChatRoom {
  users: Set<string>;
  messages: Array<{ user: string; text: string }>;
}

class ChatServer extends GenServer<ChatRoom> {
  init() {
    return { users: new Set(), messages: [] };
  }

  handleCast(msg: { type: 'join'; user: string } |
                  { type: 'message'; user: string; text: string }) {
    if (msg.type === 'join') {
      this.state.users.add(msg.user);
      EventBus.broadcast('chat:join', { user: msg.user });
    } else if (msg.type === 'message') {
      this.state.messages.push({ user: msg.user, text: msg.text });
      EventBus.broadcast('chat:message', msg);
    }
  }

  handleCall(msg: { type: 'getMessages' }) {
    return this.state.messages;
  }
}

// Register globally
const chat = await ChatServer.start();
Registry.register('chat:lobby', chat);

// Users can join from anywhere
await chat.cast({ type: 'join', user: 'Alice' });
await chat.cast({ type: 'message', user: 'Alice', text: 'Hello!' });`,
      output: [
        '$ npx ts-node chat.ts',
        '',
        '✓ ChatServer started (pid: <chat_lobby>)',
        '✓ Registered as "chat:lobby"',
        '',
        '→ cast: { type: "join", user: "Alice" }',
        '  ↳ broadcast: chat:join { user: "Alice" }',
        '',
        '→ cast: { type: "message", user: "Alice", text: "Hello!" }',
        '  ↳ broadcast: chat:message { user: "Alice", text: "Hello!" }',
      ],
    },
    worker: {
      code: `import { GenServer, Supervisor, DynamicSupervisor } from '@hamicek/noex';

class Worker extends GenServer<{ taskCount: number }> {
  init() {
    return { taskCount: 0 };
  }

  async handleCall(msg: { type: 'process'; data: string }) {
    this.state.taskCount++;
    // Simulate processing
    await new Promise(r => setTimeout(r, 100));
    return { processed: msg.data.toUpperCase(), count: this.state.taskCount };
  }
}

// Create a pool of workers with automatic restart
const pool = new Supervisor({
  children: [
    { id: 'worker-1', start: () => Worker.start() },
    { id: 'worker-2', start: () => Worker.start() },
    { id: 'worker-3', start: () => Worker.start() },
  ],
  strategy: 'one_for_one',
  maxRestarts: 10,
});

await pool.start();

// Workers automatically restart on failure
const result = await pool.getChild('worker-1')
  .call({ type: 'process', data: 'hello' });

console.log(result);`,
      output: [
        '$ npx ts-node worker-pool.ts',
        '',
        '✓ Supervisor started',
        '  ├─ worker-1 started (pid: <worker_1>)',
        '  ├─ worker-2 started (pid: <worker_2>)',
        '  └─ worker-3 started (pid: <worker_3>)',
        '',
        '→ call worker-1: { type: "process", data: "hello" }',
        '← reply: { processed: "HELLO", count: 1 }',
        '',
        '{ processed: "HELLO", count: 1 }',
      ],
    },
    stateMachine: {
      code: `import { GenStateMachine } from '@hamicek/noex';
import type { StateMachineBehavior } from '@hamicek/noex';

type LightState = 'red' | 'green' | 'yellow';
type LightEvent = { type: 'timer' } | { type: 'emergency' };

const trafficLight: StateMachineBehavior<LightState, null, LightEvent> = {
  init: () => ({ state: 'red', data: null }),
  states: {
    red: {
      handleEvent: (event) =>
        event.type === 'timer'
          ? { type: 'transition', nextState: 'green', data: null }
          : { type: 'keep_state_and_data' }
    },
    green: {
      handleEvent: (event) =>
        event.type === 'timer'
          ? { type: 'transition', nextState: 'yellow', data: null }
          : { type: 'keep_state_and_data' }
    },
    yellow: {
      handleEvent: (event) =>
        event.type === 'timer'
          ? { type: 'transition', nextState: 'red', data: null }
          : { type: 'keep_state_and_data' }
    }
  }
};

// Start the state machine
const light = await GenStateMachine.start(trafficLight);

// Trigger state transitions
await GenStateMachine.cast(light, { type: 'timer' }); // red -> green
await GenStateMachine.cast(light, { type: 'timer' }); // green -> yellow
await GenStateMachine.cast(light, { type: 'timer' }); // yellow -> red

console.log('Traffic light cycle complete');`,
      output: [
        '$ npx ts-node traffic-light.ts',
        '',
        '✓ GenStateMachine started (pid: <fsm_1>)',
        '  state: red',
        '',
        '→ cast: { type: "timer" }',
        '  ↳ transition: red → green',
        '',
        '→ cast: { type: "timer" }',
        '  ↳ transition: green → yellow',
        '',
        '→ cast: { type: "timer" }',
        '  ↳ transition: yellow → red',
        '',
        'Traffic light cycle complete',
      ],
    },
  };

  onMount(() => {
    if (!sectionRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
            // Auto-run terminal animation when visible
            runTerminalAnimation();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(sectionRef);

    return () => observer.disconnect();
  });

  function runTerminalAnimation() {
    const output = examples[activeExample].output;
    terminalLines = [];
    isRunning = true;

    let lineIndex = 0;
    const addLine = () => {
      if (lineIndex < output.length) {
        terminalLines = [...terminalLines, output[lineIndex]];
        lineIndex++;
        setTimeout(addLine, lineIndex === 1 ? 300 : 80);
      } else {
        isRunning = false;
      }
    };

    addLine();
  }

  function switchExample(example: 'counter' | 'chat' | 'worker' | 'stateMachine') {
    activeExample = example;
    runTerminalAnimation();
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(examples[activeExample].code);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = examples[activeExample].code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    }
  }

  // Simple syntax highlighting
  function highlightCode(code: string): string {
    return code
      // Comments first
      .replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>')
      // Strings
      .replace(/('[^']*')/g, '<span class="hl-string">$1</span>')
      .replace(/("[^"]*")/g, '<span class="hl-string">$1</span>')
      .replace(/(`[^`]*`)/g, '<span class="hl-string">$1</span>')
      // Keywords
      .replace(/\b(import|from|export|class|extends|const|let|var|return|new|await|async|function|if|else|interface)\b/g, '<span class="hl-keyword">$1</span>')
      // Types and Classes
      .replace(/\b(GenServer|GenStateMachine|StateMachineBehavior|Supervisor|DynamicSupervisor|Registry|EventBus|Counter|Worker|ChatServer|ChatRoom|Set|Array|Promise|LightState|LightEvent)\b/g, '<span class="hl-class">$1</span>')
      // Numbers
      .replace(/\b(\d+)\b/g, '<span class="hl-number">$1</span>')
      // Methods/Functions
      .replace(/\b(init|handleCall|handleCast|start|register|broadcast|call|cast|getChild|setTimeout|toUpperCase|add|push)\b(?=\s*\()/g, '<span class="hl-method">$1</span>')
      // Properties
      .replace(/\b(type|user|text|data|processed|count|id|strategy|maxRestarts|children|users|messages|taskCount|state|states|init|nextState|handleEvent)\b(?=\s*[:\}])/g, '<span class="hl-property">$1</span>')
      // Built-ins
      .replace(/\b(console|document|navigator)\b/g, '<span class="hl-builtin">$1</span>')
      .replace(/\.(log|clipboard|writeText)\b/g, '.<span class="hl-method">$1</span>');
  }
</script>

<section
  bind:this={sectionRef}
  id="playground"
  class="playground-section snap-section bg-bg-primary"
  aria-labelledby="playground-title"
>
  <!-- Background elements -->
  <div class="background-elements" aria-hidden="true">
    <div class="gradient-blob gradient-blob-1"></div>
    <div class="gradient-blob gradient-blob-2"></div>
    <div class="code-pattern"></div>
  </div>

  <div class="content-wrapper max-w-6xl mx-auto relative z-10 px-4">
    <!-- Title -->
    <h2
      id="playground-title"
      class="section-title text-3xl md:text-5xl font-bold mb-4 text-text-primary text-center"
      class:visible={isVisible}
    >
      {translations.title}
    </h2>

    <p
      class="section-subtitle text-lg text-text-secondary text-center mb-8 md:mb-12 max-w-2xl mx-auto"
      class:visible={isVisible}
    >
      {translations.subtitle}
    </p>

    <!-- Example tabs -->
    <div
      class="tabs-container flex flex-wrap justify-center gap-2 md:gap-4 mb-6"
      class:visible={isVisible}
      role="tablist"
      aria-label="Code examples"
    >
      {#each ['counter', 'chat', 'worker', 'stateMachine'] as example}
        {@const exampleKey = example as 'counter' | 'chat' | 'worker' | 'stateMachine'}
        <button
          role="tab"
          aria-selected={activeExample === exampleKey}
          aria-controls={`panel-${example}`}
          class="tab-button"
          class:active={activeExample === exampleKey}
          onclick={() => switchExample(exampleKey)}
        >
          <span class="tab-icon">
            {#if example === 'counter'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V13.5zm0 2.25h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V18zm2.498-6.75h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V13.5zm0 2.25h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V18zm2.504-6.75h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zm0 2.25h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V18zm2.498-6.75h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zM8.25 6h7.5v2.25h-7.5V6zM12 2.25c-1.892 0-3.758.11-5.593.322C5.307 2.7 4.5 3.65 4.5 4.757V19.5a2.25 2.25 0 002.25 2.25h10.5a2.25 2.25 0 002.25-2.25V4.757c0-1.108-.806-2.057-1.907-2.185A48.507 48.507 0 0012 2.25z" />
              </svg>
            {:else if example === 'chat'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
              </svg>
            {:else if example === 'worker'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h3M10.5 18h3M6 10.5v3M18 10.5v3" />
              </svg>
            {/if}
          </span>
          <span class="tab-content">
            <span class="tab-name">{translations.examples[exampleKey].name}</span>
            <span class="tab-description">{translations.examples[exampleKey].description}</span>
          </span>
        </button>
      {/each}
    </div>

    <!-- Editor and Terminal panels -->
    <div
      class="panels-container grid md:grid-cols-2 gap-4 md:gap-6"
      class:visible={isVisible}
    >
      <!-- Code Editor Panel -->
      <div class="editor-panel" role="tabpanel" id={`panel-${activeExample}`}>
        <div class="panel-header">
          <div class="panel-dots">
            <span class="dot dot-red"></span>
            <span class="dot dot-yellow"></span>
            <span class="dot dot-green"></span>
          </div>
          <span class="panel-title">{activeExample}.ts</span>
          <button
            class="copy-button"
            onclick={copyCode}
            aria-label={copied ? translations.actions.copied : translations.actions.copy}
          >
            {#if copied}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span>{translations.actions.copied}</span>
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
              <span>{translations.actions.copy}</span>
            {/if}
          </button>
        </div>
        <div class="code-content">
          <pre><code>{@html highlightCode(examples[activeExample].code)}</code></pre>
        </div>
      </div>

      <!-- Terminal Panel -->
      <div class="terminal-panel">
        <div class="panel-header terminal-header">
          <div class="panel-dots">
            <span class="dot dot-red"></span>
            <span class="dot dot-yellow"></span>
            <span class="dot dot-green"></span>
          </div>
          <span class="panel-title">{translations.terminal.title}</span>
          {#if isRunning}
            <span class="running-indicator">
              <span class="running-dot"></span>
              {translations.terminal.running}
            </span>
          {/if}
        </div>
        <div class="terminal-content">
          <div class="terminal-output">
            {#each terminalLines as line, i}
              <div class="terminal-line" class:command={line.startsWith('$')} class:success={line.startsWith('✓')} class:arrow={line.startsWith('→') || line.startsWith('←') || line.startsWith('  ↳')} class:tree={line.startsWith('  ├') || line.startsWith('  └')}>
                {line}
              </div>
            {/each}
            {#if isRunning}
              <span class="cursor">▋</span>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .playground-section {
    position: relative;
    overflow: hidden;
  }

  /* Background */
  .background-elements {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .gradient-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.1;
  }

  .gradient-blob-1 {
    width: 500px;
    height: 500px;
    background: var(--color-accent-primary);
    top: 10%;
    left: -10%;
    animation: blobFloat1 20s ease-in-out infinite;
  }

  .gradient-blob-2 {
    width: 400px;
    height: 400px;
    background: var(--color-accent-secondary);
    bottom: 10%;
    right: -10%;
    animation: blobFloat2 18s ease-in-out infinite;
  }

  .code-pattern {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 255, 136, 0.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 136, 0.015) 1px, transparent 1px);
    background-size: 30px 30px;
  }

  @keyframes blobFloat1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(30px, -20px) scale(1.05); }
  }

  @keyframes blobFloat2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(-20px, 30px) scale(1.08); }
  }

  /* Title animations */
  .section-title {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
  }

  .section-title.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .section-subtitle {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease-out 0.15s, transform 0.6s ease-out 0.15s;
  }

  .section-subtitle.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Tabs */
  .tabs-container {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease-out 0.2s, transform 0.5s ease-out 0.2s;
  }

  .tabs-container.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .tab-button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    background: rgba(26, 26, 46, 0.6);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.3s ease;
    backdrop-filter: blur(8px);
  }

  .tab-button:hover {
    border-color: var(--color-accent-primary);
    color: var(--color-text-primary);
  }

  .tab-button.active {
    background: rgba(0, 255, 136, 0.1);
    border-color: var(--color-accent-primary);
    color: var(--color-accent-primary);
    box-shadow: 0 0 20px rgba(0, 255, 136, 0.15);
  }

  .tab-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
  }

  .tab-icon svg {
    width: 100%;
    height: 100%;
  }

  .tab-content {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
  }

  .tab-name {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .tab-description {
    font-size: 0.75rem;
    opacity: 0.7;
    display: none;
  }

  @media (min-width: 768px) {
    .tab-description {
      display: block;
    }
  }

  /* Panels container */
  .panels-container {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease-out 0.3s, transform 0.6s ease-out 0.3s;
  }

  .panels-container.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Panel shared styles */
  .editor-panel,
  .terminal-panel {
    background: rgba(10, 10, 15, 0.9);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 400px;
    max-height: 500px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(26, 26, 46, 0.8);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-dots {
    display: flex;
    gap: 6px;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .dot-red { background: #ff5f56; }
  .dot-yellow { background: #ffbd2e; }
  .dot-green { background: #27ca40; }

  .panel-title {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    flex: 1;
  }

  /* Copy button */
  .copy-button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .copy-button:hover {
    border-color: var(--color-accent-primary);
    color: var(--color-accent-primary);
  }

  .copy-button svg {
    width: 14px;
    height: 14px;
  }

  /* Code editor content */
  .code-content {
    flex: 1;
    overflow: auto;
    padding: 1rem;
  }

  .code-content pre {
    margin: 0;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--color-text-secondary);
  }

  .code-content code {
    display: block;
    white-space: pre;
  }

  /* Syntax highlighting */
  .code-content :global(.hl-keyword) {
    color: var(--color-accent-secondary);
  }

  .code-content :global(.hl-class) {
    color: var(--color-accent-primary);
  }

  .code-content :global(.hl-method) {
    color: #dcdcaa;
  }

  .code-content :global(.hl-string) {
    color: #ce9178;
  }

  .code-content :global(.hl-number) {
    color: #b5cea8;
  }

  .code-content :global(.hl-property) {
    color: #9cdcfe;
  }

  .code-content :global(.hl-comment) {
    color: #6a9955;
    font-style: italic;
  }

  .code-content :global(.hl-builtin) {
    color: #4ec9b0;
  }

  /* Terminal styles */
  .terminal-header {
    background: rgba(18, 18, 26, 0.95);
  }

  .running-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--color-accent-primary);
  }

  .running-dot {
    width: 6px;
    height: 6px;
    background: var(--color-accent-primary);
    border-radius: 50%;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .terminal-content {
    flex: 1;
    overflow: auto;
    padding: 1rem;
    background: rgba(10, 10, 15, 0.95);
  }

  .terminal-output {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    line-height: 1.6;
  }

  .terminal-line {
    color: var(--color-text-secondary);
    white-space: pre;
    min-height: 1.6em;
  }

  .terminal-line.command {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .terminal-line.success {
    color: var(--color-accent-primary);
  }

  .terminal-line.arrow {
    color: var(--color-accent-secondary);
  }

  .terminal-line.tree {
    color: var(--color-text-secondary);
    opacity: 0.8;
  }

  .cursor {
    color: var(--color-accent-primary);
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .editor-panel,
    .terminal-panel {
      min-height: 300px;
      max-height: 400px;
    }
  }

  @media (max-width: 768px) {
    .tab-button {
      padding: 0.5rem 1rem;
    }

    .tab-icon {
      width: 20px;
      height: 20px;
    }

    .editor-panel,
    .terminal-panel {
      min-height: 280px;
      max-height: 350px;
    }

    .code-content pre,
    .terminal-output {
      font-size: 0.7rem;
    }

    .gradient-blob-1 {
      width: 280px;
      height: 280px;
      opacity: 0.05;
    }

    .gradient-blob-2 {
      width: 220px;
      height: 220px;
      opacity: 0.05;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .section-title,
    .section-subtitle,
    .tabs-container,
    .panels-container {
      transition: none;
      opacity: 1;
      transform: none;
    }

    .gradient-blob-1,
    .gradient-blob-2 {
      animation: none;
    }

    .running-dot,
    .cursor {
      animation: none;
    }
  }
</style>
