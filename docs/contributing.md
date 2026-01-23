# Contributing to noex

Thank you for your interest in contributing to noex! This guide will help you get started.

## Code of Conduct

By participating in this project, you agree to maintain a welcoming and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Git

### Setup

1. Fork the repository on GitHub

2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/noex.git
   cd noex
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Project Structure

```
noex/
├── src/
│   ├── core/           # GenServer, Supervisor, Registry, process linking
│   ├── services/       # Cache, EventBus, RateLimiter, TimerService
│   ├── observer/       # Observer, AlertManager
│   ├── dashboard/      # Dashboard server
│   ├── distribution/   # Cluster, RemoteCall, RemoteSpawn, RemoteLink
│   ├── persistence/    # Storage adapters, EventLog, PersistenceManager
│   └── bin/            # CLI tools (noex-init, noex-dashboard)
├── tests/              # Test files (mirrors src/ structure)
├── examples/           # Example applications
├── docs/               # Documentation
└── noex-website/       # Project website (Astro + Svelte)
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Building

```bash
# Build the project
npm run build

# Type check without building
npm run typecheck

# Clean build artifacts
npm run clean
```

## Making Changes

### Code Style

- Use TypeScript for all source files
- Follow existing code patterns
- Keep functions focused and small

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat: add rate limiter sliding window algorithm
fix: handle timeout in GenServer.call
docs: improve Supervisor API documentation
test: add tests for Registry edge cases
refactor: simplify message queue implementation
```

Prefixes:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test changes
- `refactor`: Code refactoring
- `chore`: Build/tooling changes

### Writing Tests

All new features should include tests. Tests use [Vitest](https://vitest.dev/) and follow the behavioral pattern:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { GenServer, type GenServerBehavior, type GenServerRef } from '../src/index.js';

function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      return [state, state];
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('Counter', () => {
  let ref: GenServerRef;

  afterEach(async () => {
    if (GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  });

  it('should increment', async () => {
    ref = await GenServer.start(createCounterBehavior());
    await GenServer.cast(ref, 'inc');
    const value = await GenServer.call(ref, 'get');
    expect(value).toBe(1);
  });
});
```

### Documentation

For new features:

1. Add relevant documentation in `docs/`
2. Add examples if appropriate
3. Update both EN and CS versions if applicable

## Pull Request Process

1. **Add tests** for new functionality
2. **Run the test suite** and ensure all tests pass
3. **Update documentation** if you changed any APIs
4. **Submit a pull request** with a clear description

### PR Title Format

```
feat: Add rate limiter burst mode
fix: Prevent race condition in Registry
docs: Add tutorial for worker pools
```

### PR Description Template

```markdown
## Description
Brief description of the changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
Describe how you tested these changes.

## Checklist
- [ ] Tests pass locally
- [ ] Code follows project style
- [ ] Documentation updated
```

## Issue Reporting

### Bug Reports

Include:
- noex version
- Node.js version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Minimal reproduction code

### Feature Requests

Include:
- Clear description of the feature
- Use case / motivation
- Proposed API (if applicable)
- Examples of similar features in other libraries

## Questions?

- Open an issue for questions about contributing
- Check existing issues and PRs for similar work
- Review the documentation for understanding the codebase

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (MIT).
