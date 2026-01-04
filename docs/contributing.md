# Contributing to noex

Thank you for your interest in contributing to noex! This guide will help you get started.

## Code of Conduct

By participating in this project, you agree to maintain a welcoming and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
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
│   ├── core/           # GenServer, Supervisor, Registry
│   ├── services/       # Cache, EventBus, RateLimiter
│   ├── observer/       # Observer, AlertManager
│   └── dashboard/      # Dashboard server
├── tests/              # Test files
├── examples/           # Example applications
└── docs/               # Documentation
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Building

```bash
# Build the project
npm run build

# Type check without building
npm run typecheck
```

### Linting

```bash
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix
```

## Making Changes

### Code Style

- Use TypeScript for all source files
- Follow existing code patterns
- Add JSDoc comments for public APIs
- Keep functions focused and small

### Commit Messages

Use clear, descriptive commit messages:

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

All new features should include tests:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, type GenServerBehavior } from '../src';

describe('MyFeature', () => {
  let ref: GenServerRef;

  beforeEach(async () => {
    ref = await GenServer.start(myBehavior);
  });

  afterEach(async () => {
    if (GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
  });

  it('should do something', async () => {
    const result = await GenServer.call(ref, 'test');
    expect(result).toBe(expectedValue);
  });
});
```

### Documentation

For new features:

1. Add JSDoc comments to the code
2. Update relevant documentation files in `docs/`
3. Add examples if appropriate

## Pull Request Process

1. **Update documentation** if you changed any APIs
2. **Add tests** for new functionality
3. **Run the test suite** and ensure all tests pass
4. **Update the changelog** if applicable
5. **Submit a pull request** with a clear description

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
- [ ] Changelog updated (if applicable)
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
