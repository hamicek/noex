# Part 1: Introduction

This section explains why noex exists and introduces the core concepts you'll use throughout the framework.

## Chapters

### [1.1 Why noex?](./01-why-noex.md)

Learn about the problems with traditional Node.js applications and how the actor model provides elegant solutions for:
- Shared state and race conditions
- Error handling complexity
- Building resilient systems

### [1.2 Key Concepts](./02-key-concepts.md)

Get an overview of the fundamental concepts:
- **Processes (GenServer)** - Isolated state containers
- **Messages (call/cast)** - The only way to communicate
- **Supervision** - Automatic recovery from failures
- **"Let it crash"** - A new way of thinking about errors

## What You'll Learn

By the end of this section, you'll understand:
- Why traditional approaches fall short for stateful applications
- What the actor model is and why it works
- How Erlang/OTP patterns translate to TypeScript
- The philosophy behind "let it crash"

---

Start with: [Why noex?](./01-why-noex.md)
